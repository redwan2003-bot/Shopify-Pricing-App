import type { PrismaClient } from "@prisma/client";
import { handlePricingApiRequest } from "./handler.ts";
import type { ApiErrorBody } from "./types.ts";
import type { PricingCalculationResult } from "../pricing/index.ts";
import {
  buildCartPricingPayload,
  signCartPricingPayload,
  buildCartPricingPayloadV2,
  signCartPricingPayloadV2,
} from "./cart-signature.ts";
import type {
  SignedCartPricingPayload,
  SignedCartPricingPayloadV2,
  CartPricingPolicyProvider,
  CartPricingEnforcementContext,
} from "./cart-signature.ts";
import { normalizeConfig } from "./config-normalization.ts";
import { resolveEnforceableCurrency } from "./currency-contract.ts";
import { toProductGid, toVariantGid, type AdminGraphqlClientLike } from "./product-resolver.ts";
import {
  createDefaultCartPricingPolicyProvider,
  type EnforcementUiState,
} from "./cart-pricing-policy-provider.ts";
import { CART_PRICING_LIMITS } from "./cart-pricing-contract.ts";

export type { EnforcementUiState } from "./cart-pricing-policy-provider.ts";

/**
 * The storefront-facing pricing payload — everything a theme needs to render a price
 * breakdown, minus `source` (storeId/pricingProfileId/resolvedVia). Those are internal
 * bookkeeping with no use to a storefront customer, so — unlike the admin-facing
 * `/api/pricing` response, which returns `PricingCalculationResult` verbatim — this is
 * deliberately trimmed. See docs/storefront-pricing-bridge.md ("Response format").
 *
 * `cartPricing` (new) is the signed payload the Add to Cart flow attaches to the cart
 * line as attributes for `imprintid-cart-pricing` (the Cart Transform Function) to
 * verify — see cart-signature.ts. `null` whenever the caller didn't supply a
 * `shopifyVariantId` in the request body (see `handleStorefrontPricingRequest` below);
 * existing callers that never send that field see no change in behavior at all.
 *
 * `identity` (Task 4A) is the canonical Shopify product/variant this quote is for, plus
 * how the pricing profile was resolved (`product_override` | `sku`) — so the storefront
 * can confirm a response still matches what the customer currently has selected before
 * rendering it (quote ownership). `null` for a legacy SKU-only request that carried no
 * Shopify ids. No internal DB id is ever included.
 */
export interface StorefrontPricingIdentity {
  shopifyProductId: string;
  shopifyVariantId: string;
  resolutionSource: "product_override" | "sku";
}

export type StorefrontPricingData = Omit<PricingCalculationResult, "source"> & {
  /** Envelope v1 (`{version:1,...}`) or v2 (`{version:2, config, ...}`). `null` when no
   * signed quote could be produced (no variant id, missing signing config, or — for an
   * explicit v2 request — no authoritative policy revisions yet). */
  cartPricing: SignedCartPricingPayload | SignedCartPricingPayloadV2 | null;
  identity: StorefrontPricingIdentity | null;
  /**
   * Task 5B.3A.1 — the AUTHORITATIVE three-state enforcement decision for this product,
   * so the storefront can tell a *safe native bypass* apart from a *mandatory
   * fail-closed*:
   *   - `enforce` — enforced; a signed `cartPricing` is present; keep the native cart contained.
   *   - `bypass`  — enforcement explicitly OFF for this product (disabled shop, or a
   *                 pilot-unmarked product): no `cartPricing`; RELEASE native containment.
   *   - `block`   — fail-closed (maintenance / malformed / inactive policy / missing
   *                 config / provider failure): no `cartPricing`; keep contained.
   * The reason behind a `bypass`/`block` stays server-side (logs only). Always present
   * on a successful response; the storefront defaults to `block` when it is absent.
   */
  enforcement: { state: EnforcementUiState };
};

/** Canonical Shopify ids for one storefront pricing request, already validated as bare
 * decimal strings by `resolveStorefrontProductContext` (product-resolver.ts). Passed
 * explicitly by the route — never re-read from `rawBody` here. */
export interface StorefrontRequestIdentity {
  shopifyProductId: string;
  shopifyVariantId: string;
}

export interface StorefrontSuccessBody {
  ok: true;
  data: StorefrontPricingData;
}

export type StorefrontResponseBody = StorefrontSuccessBody | ApiErrorBody;

export interface StorefrontResult {
  status: number;
  body: StorefrontResponseBody;
}

/**
 * The storefront pricing bridge's core logic. Delegates entirely to
 * `handlePricingApiRequest` (the same function `/api/pricing` uses) for request
 * validation, calling the Phase 2.3 engine, and error-to-status mapping — nothing
 * pricing-related is reimplemented here. The only things this function adds are
 * trimming `source` from a successful response, and — when the caller supplies a
 * `shopifyVariantId` — attaching a signed cart pricing payload built from the exact
 * result the engine already returned (see cart-signature.ts; still no calculation of
 * any kind happens here).
 *
 * `shopDomain` is a parameter for the same reason as in `handlePricingApiRequest`:
 * the caller (the App Proxy route) is responsible for resolving it from Shopify's
 * verified proxy context, never from `rawBody`.
 *
 * `shopifyVariantId` is read directly off `rawBody` here rather than through
 * `parsePricingRequestBody`/`CalculationInput` deliberately: it plays no part in
 * pricing calculation (the engine never sees it), it only identifies which cart line
 * the resulting signed payload is for — so it doesn't belong in the calculation input
 * type. A malformed or missing value simply means no cart payload is produced; it's
 * never treated as a calculation error.
 */
/** Optional server-trusted dependencies for v2 quote issuance. `admin` comes from the
 * verified App Proxy session; `policyProvider` is an override for tests. When neither is
 * supplied the provider is built from `admin` (or `null` ⇒ fails closed). */
export interface StorefrontPricingOptions {
  admin?: AdminGraphqlClientLike | null;
  policyProvider?: CartPricingPolicyProvider;
}

export async function handleStorefrontPricingRequest(
  prisma: PrismaClient,
  shopDomain: string,
  rawBody: unknown,
  requestIdentity?: StorefrontRequestIdentity | null,
  pricingOptions?: StorefrontPricingOptions,
): Promise<StorefrontResult> {
  const result = await handlePricingApiRequest(prisma, shopDomain, rawBody);

  if (!result.body.ok) {
    return { status: result.status, body: result.body };
  }

  const {
    quantity,
    quantityTier,
    availableQuantityTiers,
    base,
    productColor,
    decoration,
    options,
    production,
    packaging,
    totals,
    source,
  } = result.body.data;

  // Envelope selection (Task 5B.1.1). There is NO silent default to v1.
  //   - v2 is the intended production version.
  //   - A NEW v1 quote is issued only for a controlled non-production transition.
  //
  // Task 5B.3A.1 — the AUTHORITATIVE THREE-STATE decision. Resolved for every
  // product-context request (not just v2) so a `bypass` state (disabled shop /
  // pilot-unmarked product) is reported to the storefront regardless of envelope. The
  // storefront defaults to `block` (stay contained) — this handler only ever moves it
  // to `bypass` on an explicit, observed policy state, or to `enforce` once a complete
  // signed v2 quote actually exists.
  const envelope = selectCartEnvelope();
  let cartPricing: StorefrontPricingData["cartPricing"] = null;
  let enforcementState: EnforcementUiState = "block";

  if (requestIdentity) {
    const provider =
      pricingOptions?.policyProvider ??
      createDefaultCartPricingPolicyProvider({ prisma, admin: pricingOptions?.admin ?? null });
    const decision = await provider.resolve({
      shopDomain,
      shopifyProductId: requestIdentity.shopifyProductId,
      pricingProfileId: source.pricingProfileId,
      pricingProfileSku: source.pricingProfileSku,
    });

    if (decision.action === "bypass") {
      enforcementState = "bypass";
    } else if (decision.action === "block") {
      console.warn(
        `[cart-pricing:v2] policy decision: block (${decision.reason}) — no signed quote; native cart stays contained.`,
      );
      enforcementState = "block";
    } else if (envelope === "v2") {
      cartPricing = await buildSignedV2Quote(prisma, result.body.data, requestIdentity, decision.context);
      enforcementState = cartPricing ? "enforce" : "block";
    } else {
      // An enforced product on a deployment that cannot issue a v2 quote → fail closed.
      enforcementState = "block";
    }
  }

  // Legacy v1 transition (non-production only): reached only when no v2 quote was
  // produced. A v1 quote implies enforcement.
  if (!cartPricing && envelope === "v1") {
    cartPricing = await buildSignedCartPricingIfRequested(prisma, rawBody, result.body.data);
    if (cartPricing) enforcementState = "enforce";
  }

  // Task 4A: echo the canonical identity so the storefront can enforce quote ownership.
  // The resolution source comes from the engine's own `source.resolvedVia` (the
  // authoritative decision), never re-derived here — so it can't drift from what
  // actually priced the request.
  const identity: StorefrontPricingIdentity | null = requestIdentity
    ? {
        shopifyProductId: requestIdentity.shopifyProductId,
        shopifyVariantId: requestIdentity.shopifyVariantId,
        resolutionSource: source.resolvedVia === "override" ? "product_override" : "sku",
      }
    : null;

  return {
    status: result.status,
    body: {
      ok: true,
      data: {
        quantity,
        quantityTier,
        availableQuantityTiers,
        base,
        productColor,
        decoration,
        options,
        production,
        packaging,
        totals,
        cartPricing,
        identity,
        enforcement: { state: enforcementState },
      },
    },
  };
}

/**
 * Task 5B.3A.1 — whether this deployment could actually PRODUCE a signed v2 quote right
 * now: envelope v2 + a valid signing secret + a valid adjustment-variant GID (all
 * env-derived). Used by the catalog route to give the storefront an early, accurate
 * enforcement state on load. Never logs an environment value.
 */
export function canIssueSignedV2Quote(): boolean {
  return (
    selectCartEnvelope() === "v2" &&
    validateSigningSecret(process.env.IMPRINTID_CART_SIGNING_SECRET) !== null &&
    adjustmentVariantPin().ok
  );
}

/**
 * The adjustment variant a v2 quote uses comes from each shop's own app-owned enforcement
 * policy (written by install-time setup; merchants cannot edit it), so one deployment can
 * serve many shops. `IMPRINTID_ADJUSTMENT_VARIANT_ID` is an OPTIONAL pin for a single-shop
 * deployment: unset means "use the shop's policy"; set to a valid GID means the shop's policy
 * must equal it; set to anything invalid fails closed.
 */
export function adjustmentVariantPin(): { ok: true; pin: string | null } | { ok: false } {
  const raw = process.env.IMPRINTID_ADJUSTMENT_VARIANT_ID;
  if (raw === undefined || raw === "") return { ok: true, pin: null };
  const pin = validateAdjustmentVariantGid(raw);
  return pin ? { ok: true, pin } : { ok: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Production runtime detection. `NODE_ENV === "production"` is the standard signal and
 * is set by the platform, never by this app. */
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Which signed-quote envelope (if any) this deployment may ISSUE. Task 5B.1.1:
 *   - `"v2"`   — the intended production version (`IMPRINTID_CART_ENVELOPE_VERSION="2"`).
 *   - `"v1"`   — ONLY when ALL of: not production, `IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1`
 *               is exactly `"true"`, and `IMPRINTID_CART_ENVELOPE_VERSION` is exactly `"1"`.
 *               For controlled non-production transition fixtures only.
 *   - `"none"` — anything else, including an absent or unsupported version. NO silent
 *               downgrade to v1; production NEVER issues a new v1 quote.
 * Never logs an environment value.
 */
export function selectCartEnvelope(): "v2" | "v1" | "none" {
  const requested = process.env.IMPRINTID_CART_ENVELOPE_VERSION;
  if (requested === "2") return "v2";
  if (requested === "1") {
    if (isProductionRuntime()) return "none";
    if (process.env.IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1 !== "true") return "none";
    return "v1";
  }
  return "none";
}

/**
 * Validates `IMPRINTID_CART_SIGNING_SECRET`. This is a *dedicated* secret for signing
 * cart pricing payloads — never `SHOPIFY_API_SECRET` (the OAuth app secret), which
 * remains reserved for Shopify authentication/App Proxy verification only (see
 * shopify.server.ts). There is no fallback between the two: if this variable isn't set,
 * cart pricing is simply unavailable, never silently signed with the wrong secret.
 *
 * Rejects `undefined`, an empty/whitespace-only value, AND any value with leading or
 * trailing whitespace — deliberately never trims a non-blank secret. A secret
 * accidentally copied with a trailing newline/space must be caught as a configuration
 * error, not silently "fixed" into a value the operator never actually verified is
 * exactly correct (that value would also need to exactly match what's baked into the
 * Cart Transform Function — see extensions/imprintid-cart-pricing/scripts/
 * generate-config.mjs — so quietly normalizing it here could mask a real mismatch).
 * Returns the exact validated bytes, unmodified, so signing always uses precisely what
 * was configured.
 */
export function validateSigningSecret(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.trim().length === 0) return null;
  if (value !== value.trim()) return null;
  return value;
}

/**
 * Validates `IMPRINTID_ADJUSTMENT_VARIANT_ID`. Requires the complete Shopify
 * ProductVariant GID form (`gid://shopify/ProductVariant/<positive-numeric-id>`) —
 * never a bare numeric id, never another resource type, never a placeholder string.
 * Deliberately does *not* construct a GID from a numeric-only value: accepting one
 * would mean silently trusting an ambiguous/incomplete configuration value instead of
 * failing closed. Trims only surrounding whitespace before validating (unlike the
 * signing secret above — a GID has no comparable "must match byte-for-byte elsewhere"
 * constraint, so trimming incidental whitespace here is safe and merely convenient).
 */
export function validateAdjustmentVariantGid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Builds a signed cart pricing payload iff the caller supplied a well-formed
 * `shopifyVariantId` string and this store has a valid `IMPRINTID_CART_SIGNING_SECRET`
 * and `IMPRINTID_ADJUSTMENT_VARIANT_ID` configured (see cart-signature.ts's doc comment
 * for what the adjustment variant is and why only one is needed). Returns `null` —
 * never throws — for any missing/misconfigured piece, since the absence of a cart
 * payload is a valid, harmless state (the storefront simply won't be able to add this
 * configuration to cart yet), not a pricing error.
 *
 * Diagnostics: warnings below name the offending environment variable and the failure
 * category only — never its value. The signing secret's value must never appear in
 * logs; the adjustment-variant value isn't secret, but is still withheld here to keep
 * this function's one warning-construction path simple and impossible to accidentally
 * extend into logging something sensitive later.
 */
async function buildSignedCartPricingIfRequested(
  prisma: PrismaClient,
  rawBody: unknown,
  result: PricingCalculationResult,
): Promise<SignedCartPricingPayload | null> {
  if (!isPlainObject(rawBody)) return null;
  const shopifyVariantId = rawBody.shopifyVariantId;
  if (typeof shopifyVariantId !== "string" || shopifyVariantId.trim().length === 0) return null;

  const secret = validateSigningSecret(process.env.IMPRINTID_CART_SIGNING_SECRET);
  if (!secret) {
    console.warn(
      "[cart-pricing] IMPRINTID_CART_SIGNING_SECRET is missing, blank, or contains leading/trailing " +
        "whitespace — no cart pricing payload will be produced.",
    );
    return null;
  }

  const adjustmentVariantId = validateAdjustmentVariantGid(process.env.IMPRINTID_ADJUSTMENT_VARIANT_ID);
  if (!adjustmentVariantId) {
    console.warn(
      "[cart-pricing] IMPRINTID_ADJUSTMENT_VARIANT_ID is not set to a valid ProductVariant GID " +
        "(expected gid://shopify/ProductVariant/<positive-numeric-id>) — no cart pricing payload will be produced.",
    );
    return null;
  }

  const profile = await prisma.pricingProfile.findUnique({
    where: { id: result.source.pricingProfileId },
    select: { currency: true },
  });
  const currency = profile?.currency ?? "USD";

  const payload = buildCartPricingPayload(result, currency, shopifyVariantId, adjustmentVariantId);
  return signCartPricingPayload(payload, secret);
}

/**
 * Builds a PII-free plain object describing the priced configuration, derived ONLY from
 * the authoritative `PricingCalculationResult` (never from raw browser/React state). Its
 * SHA-256 is the signed `configDigest`; the same JSON travels as the
 * `_imprintid_pricing_config` cart attribute for the Function to re-hash and compare.
 */
function buildConfigDigestInput(result: PricingCalculationResult): Record<string, unknown> {
  const optionValueIds = result.options.selections.map((s) => s.optionValueId).sort();
  const decorationChargeCodes = result.decoration
    ? result.decoration.charges.map((c) => c.code).sort()
    : [];
  return {
    quantity: result.quantity,
    productColorCode: result.productColor?.code ?? null,
    decorationMethod: result.decoration?.method ?? null,
    decorationChargeCodes,
    optionValueIds,
    productionCode: result.production.code,
    packagingCode: result.packaging?.code ?? null,
  };
}

/**
 * Envelope v2 (Task 5B.1 / 5B.3A.1). Given an already-resolved `enforce` decision's
 * context, produces the complete signed v2 quote — or `null` (the caller then reports
 * enforcement state `block`) for any of: missing/invalid signing secret, missing/
 * invalid or shop-policy-mismatched adjustment GID, config that will not normalize, or
 * a quote that would breach a transport byte ceiling. Never falls back to v1.
 */
async function buildSignedV2Quote(
  prisma: PrismaClient,
  result: PricingCalculationResult,
  requestIdentity: StorefrontRequestIdentity,
  enforcement: CartPricingEnforcementContext,
): Promise<SignedCartPricingPayloadV2 | null> {
  // Identity is the AUTHORITATIVE, Admin-verified product/variant (validated bare
  // decimal ids in `resolveStorefrontProductContext`) — never a browser value.
  const variantGid = toVariantGid(requestIdentity.shopifyVariantId);
  const productGid = toProductGid(requestIdentity.shopifyProductId);

  const secret = validateSigningSecret(process.env.IMPRINTID_CART_SIGNING_SECRET);
  if (!secret) {
    console.warn("[cart-pricing:v2] IMPRINTID_CART_SIGNING_SECRET missing/invalid — no v2 quote produced.");
    return null;
  }
  const pin = adjustmentVariantPin();
  if (!pin.ok) {
    console.warn("[cart-pricing:v2] IMPRINTID_ADJUSTMENT_VARIANT_ID is set but invalid — no v2 quote produced.");
    return null;
  }
  const adjustmentVariantId = validateAdjustmentVariantGid(enforcement.adjustmentVariantGid);
  if (!adjustmentVariantId) {
    console.warn("[cart-pricing:v2] shop policy has no valid adjustment variant — no v2 quote produced.");
    return null;
  }
  if (pin.pin !== null && pin.pin !== adjustmentVariantId) {
    console.warn("[cart-pricing:v2] adjustment variant GID mismatch between env pin and shop policy — failing closed.");
    return null;
  }

  // Task 5B.3B.2 — CURRENCY SAFETY. Issue a signed, enforceable quote ONLY when the
  // authoritative pricing-profile currency equals the authenticated shop currency. No
  // FX, no default: a missing profile currency or any mismatch produces no quote (the
  // storefront then reports enforcement state `block` and stays contained).
  const profile = await prisma.pricingProfile.findUnique({
    where: { id: result.source.pricingProfileId },
    select: { currency: true },
  });
  const currencyGate = resolveEnforceableCurrency(profile?.currency, enforcement.shopCurrency);
  if (!currencyGate.ok) {
    console.warn(
      `[cart-pricing:v2] currency safety — ${currencyGate.reason}: no v2 quote produced ` +
        "(the initial release performs no currency conversion; the pricing-profile currency must equal the shop currency).",
    );
    return null;
  }
  const currency = currencyGate.currency;

  const normalized = normalizeConfig(buildConfigDigestInput(result));
  if (!normalized.ok) {
    console.warn(`[cart-pricing:v2] configuration normalization failed (${normalized.reason}) — no v2 quote produced.`);
    return null;
  }

  const payload = buildCartPricingPayloadV2({
    result,
    currency,
    variantGid,
    productGid,
    enforcement,
    normalizedConfigJson: normalized.canonicalJson,
    configDigest: normalized.digest,
  });
  const signed = signCartPricingPayloadV2(payload, normalized.canonicalJson, secret);

  // Enforce the transport byte ceilings BEFORE returning — a quote whose serialized
  // payload or config attribute would exceed its limit is treated as unusable (the
  // storefront would reject it anyway on the way into `/cart/add.js`). Fail closed.
  if (
    utf8ByteLength(signed.payload) > CART_PRICING_LIMITS.maxPayloadBytes ||
    utf8ByteLength(signed.config) > CART_PRICING_LIMITS.maxConfigBytes
  ) {
    console.warn("[cart-pricing:v2] signed quote exceeds a transport byte limit — no v2 quote produced.");
    return null;
  }
  return signed;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
