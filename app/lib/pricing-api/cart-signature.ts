import { randomUUID } from "node:crypto";
import { signHex } from "./hmac-sha256.ts";
import type { PricingCalculationResult } from "../pricing/index.ts";
import {
  ENVELOPE_V2,
  canonicalizeCartPricingPayloadV2,
  checkMonetaryInvariants,
  computeLineTotalCents,
  type CartPricingPayloadV2,
} from "./cart-pricing-contract.ts";

/**
 * Turns a real `PricingCalculationResult` (never anything else — see
 * `buildCartPricingPayload` below) into a signed payload the storefront can carry into
 * a Shopify cart line as attributes, and the `imprintid-cart-pricing` Cart Transform
 * Function can verify without any network/database access — see
 * `docs/storefront-pricing-bridge.md` for the end-to-end contract and
 * `extensions/imprintid-cart-pricing/src/verify-payload.ts` for the verifying side
 * (kept in sync with this file's canonicalization by construction — both call the
 * identical `hmacSha256` implementation on an identical canonical string).
 *
 * PRICE DECOMPOSITION — why 3 numbers, not 1:
 *
 * `PricingCalculationResult.totals.netTotalCents` is a *line total*, but Shopify's
 * `expand` Cart Transform operation only accepts *per-unit* prices
 * (`ExpandedItem.price.fixedPricePerUnit`) for each component of the expanded bundle —
 * see docs/pricing-model-expansion.md and the Cart Transform schema fetched for API
 * version 2026-07. Rather than divide the line total by quantity (which loses cents
 * whenever a flat one-time charge doesn't divide evenly — e.g. a $45.00 setup fee over
 * 1000 units), this payload carries the calculation's *already-per-unit-or-flat*
 * components separately, so the Function can reconstruct the exact original total with
 * zero rounding:
 *
 *   - `baseUnitPriceCents`      = `base.netUnitPriceCents`                 (exact, per unit)
 *   - `perUnitSurchargeCents`   = sum of every PER_UNIT DecorationChargeLine's
 *                                 `netPriceCents` (the rate itself, not the line total —
 *                                 exact, per unit)
 *   - `flatSurchargeCents`      = sum of every ONE_TIME DecorationChargeLine's
 *                                 `netLineTotalCents`, plus `options.chargesCents`,
 *                                 `production.feeCents`, `packaging.feeCents`, and
 *                                 `productColor.priceAdjustmentCents` (all flat/one-time
 *                                 by construction in this engine — see calculator.ts)
 *
 * `baseUnitPriceCents * quantity + perUnitSurchargeCents * quantity + flatSurchargeCents`
 * is algebraically identical to `totals.netTotalCents` — this is a re-grouping of the
 * exact same numbers the engine already produced, not a new calculation.
 */
export interface CartPricingPayload {
  v: 1;
  sku: string;
  quantity: number;
  currency: string;
  baseVariantId: string;
  baseUnitPriceCents: number;
  perUnitSurchargeCents: number;
  flatSurchargeCents: number;
  adjustmentVariantId: string;
  expiresAt: number;
}

export interface SignedCartPricingPayload {
  version: 1;
  payload: string; // canonical JSON string of CartPricingPayload — signed verbatim
  signature: string; // lowercase hex HMAC-SHA256 of `payload`
}

const PAYLOAD_TTL_SECONDS = 30 * 60; // 30 minutes — long enough to complete an add-to-cart, short enough to bound replay risk

/**
 * Task 5B.3A — advisory lifetime of a v2 quote, in seconds. There is NO `expiresAt`
 * FIELD in the v2 payload: the Cart Transform / Validation Functions are deterministic
 * and MUST NOT compare a clock (Task 5A constraint #8), and adding a signed clock field
 * would ripple through the mirrored contract + golden vectors for no Function benefit.
 * Instead expiry is DERIVED from the already-signed `issuedAtServer`
 * (`expiry = issuedAtServer + V2_QUOTE_TTL_SECONDS`) and enforced only where a clock is
 * legitimate: the browser, before it enables Add to Cart and before it submits. The
 * value is mirrored verbatim into
 * `extensions/imprintid-dynamic-pricing/assets/dynamic-pricing-utils.js`.
 */
export const V2_QUOTE_TTL_SECONDS = 30 * 60;

/**
 * Builds the exact `CartPricingPayload` for one calculation, deriving every field from
 * the already-computed `PricingCalculationResult` — no re-calculation, no independent
 * source of prices. Returns `null` when the result carries no decoration (nothing to
 * decompose beyond the base) — still valid, `perUnitSurchargeCents`/`flatSurchargeCents`
 * are simply both `0` in that case, so this only returns `null` if the shape genuinely
 * can't be represented (never happens today; kept for forward-compatibility, e.g. a
 * future `requiresQuote` result this engine doesn't yet produce).
 */
export function buildCartPricingPayload(
  result: PricingCalculationResult,
  currency: string,
  baseVariantId: string,
  adjustmentVariantId: string,
  now: number = Math.floor(Date.now() / 1000),
): CartPricingPayload {
  let perUnitSurchargeCents = 0;
  let flatSurchargeCents = 0;

  if (result.decoration) {
    for (const line of result.decoration.charges) {
      if (line.chargeBasis === "PER_UNIT") {
        perUnitSurchargeCents += line.netPriceCents;
      } else {
        flatSurchargeCents += line.netLineTotalCents;
      }
    }
  }

  flatSurchargeCents += result.options.chargesCents;
  flatSurchargeCents += result.production.feeCents ?? 0;
  flatSurchargeCents += result.packaging?.feeCents ?? 0;
  flatSurchargeCents += result.productColor?.priceAdjustmentCents ?? 0;

  return {
    v: 1,
    sku: result.source.pricingProfileSku ?? "",
    quantity: result.quantity,
    currency,
    baseVariantId,
    baseUnitPriceCents: result.base.netUnitPriceCents,
    perUnitSurchargeCents,
    flatSurchargeCents,
    adjustmentVariantId,
    expiresAt: now + PAYLOAD_TTL_SECONDS,
  };
}

/**
 * Canonicalizes a payload into a deterministic string before signing — sorted
 * `key=value` pairs joined with `\n`, deliberately similar in spirit to this app's
 * existing App Proxy HMAC convention (`stringifyQueryForAppProxy` — sorted
 * `key=value`, no separator) but using an explicit newline separator instead of none,
 * since App Proxy's scheme relies on Shopify's own fixed, known query-param keys where
 * adjacent concatenation can't be ambiguous; this payload's values (e.g. a SKU) aren't
 * under that same guarantee, so a real separator is used instead.
 */
export function canonicalizeCartPricingPayload(payload: CartPricingPayload): string {
  const record = payload as unknown as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${String(record[key])}`)
    .join("\n");
}

/** Signs a `CartPricingPayload` with the caller-supplied secret — in real use, always
 * the dedicated `IMPRINTID_CART_SIGNING_SECRET` (validated in
 * `app/lib/pricing-api/storefront-handler.ts`), never `SHOPIFY_API_SECRET` (the OAuth
 * app secret, reserved for Shopify authentication/App Proxy verification — see
 * shopify.server.ts). This function itself is secret-agnostic by design — it signs
 * whatever secret it's given — so that guarantee lives entirely in the one place that
 * reads the environment, not here. */
export function signCartPricingPayload(payload: CartPricingPayload, secret: string): SignedCartPricingPayload {
  const canonical = canonicalizeCartPricingPayload(payload);
  return {
    version: 1,
    payload: JSON.stringify(payload),
    signature: signHex(secret, canonical),
  };
}

// ===========================================================================
// Envelope v2 (Task 5B.1) — bound to Shopify-owned policy revisions, no clock.
// v1 above is UNCHANGED and remains accepted only while v2 prerequisites (the
// app-owned metafield revisions) are absent — see docs/architecture for the
// transition. v2 is never enabled unless a policy provider supplies real revisions.
// ===========================================================================

/**
 * The authoritative, Shopify-owned enforcement context a v2 quote must be bound to.
 * Every field here originates from an app-owned metafield the merchant cannot edit —
 * NEVER from the storefront request body.
 *
 * - `installBinding`  : opaque per-install value from the shop `enforcement_policy`
 *                       metafield (the Function has no `Shop.id`, so this is how a quote
 *                       is bound to one install — see `cart-pricing-contract.ts`).
 * - `adjustmentVariantGid` : the shop policy's adjustment variant GID.
 * - `policyRevision` : the shop policy revision.
 * - `profileRef` / `profileRevision` : the product policy's profile identity + revision.
 * - `shopCurrency`  : the authenticated shop's own currency (Admin `shop.currencyCode`),
 *                     server-resolved alongside the policy metafields. Task 5B.3B.2 —
 *                     used ONLY as the pre-sign gate (`resolveEnforceableCurrency`):
 *                     a v2 quote is signed only when the pricing-profile currency equals
 *                     this. NEVER placed in the signed payload (`payload.currency` is the
 *                     profile currency) and never used for any conversion. Optional on
 *                     the type so existing call sites compile; `undefined` is treated as
 *                     fail-closed (`CURRENCY_CONTEXT_UNAVAILABLE` ⇒ no quote).
 */
export interface CartPricingEnforcementContext {
  installBinding: string;
  adjustmentVariantGid: string;
  policyRevision: number;
  profileRef: string;
  profileRevision: number;
  shopCurrency?: string | null;
}

/**
 * Task 5B.3A.1 — the AUTHORITATIVE THREE-STATE policy decision. A single nullable
 * "context | null" collapsed two materially different outcomes (an explicit *safe*
 * native bypass vs. a mandatory *fail-closed*), which the storefront could not tell
 * apart — so a `disabled` shop or a pilot-unmarked product stayed natively contained
 * forever. This union makes the distinction explicit:
 *
 *   - `enforce` — this product IS enforced: issue a signed v2 quote; the native cart
 *                 stays contained.
 *   - `bypass`  — enforcement is explicitly, safely OFF for this product (a `disabled`
 *                 shop policy, or a valid `pilot` policy with the product deliberately
 *                 unmarked): NO signed quote, and the storefront must RELEASE native
 *                 containment.
 *   - `block`   — a mandatory fail-closed condition (maintenance, malformed/inactive
 *                 policy, a `universal` product with no policy, a provider/GraphQL
 *                 failure, or missing signing/adjustment configuration): NO signed
 *                 quote, and the native cart stays contained.
 */
export type CartPricingPolicyBypassReason = "shop_disabled" | "pilot_unmarked";

export type CartPricingPolicyBlockReason =
  | "maintenance"
  | "shop_policy_missing"
  | "shop_policy_malformed"
  | "product_policy_malformed"
  | "required_policy_inactive"
  | "universal_policy_missing"
  | "provider_failure"
  | "configuration_unavailable";

export type CartPricingPolicyDecision =
  | { action: "enforce"; context: CartPricingEnforcementContext }
  | { action: "bypass"; reason: CartPricingPolicyBypassReason }
  | { action: "block"; reason: CartPricingPolicyBlockReason };

/**
 * Resolves the three-state policy decision for one product-context request. Reads ONLY
 * app-owned, merchant-uneditable sources (see `cart-pricing-policy-provider.ts`); never
 * the storefront request body.
 */
export interface CartPricingPolicyProvider {
  resolve(args: {
    shopDomain: string;
    shopifyProductId: string | null;
    /** Optional supporting context — the default provider resolves everything from the
     * product id + metafields and does not use these. */
    pricingProfileId?: string;
    pricingProfileSku?: string | null;
  }): Promise<CartPricingPolicyDecision>;
}

/** A provider that always fails closed with `block` — the safe stand-in when no real
 * policy source is wired (and a test double). NEVER `bypass` (that must be an explicit,
 * observed policy state), NEVER `enforce`. */
export const nullCartPricingPolicyProvider: CartPricingPolicyProvider = {
  async resolve() {
    return { action: "block", reason: "configuration_unavailable" };
  },
};

export interface SignedCartPricingPayloadV2 {
  version: typeof ENVELOPE_V2;
  /** canonical JSON string of the v2 payload — the `_imprintid_pricing_payload` attribute */
  payload: string;
  /** lowercase hex HMAC-SHA256 of `canonicalizeCartPricingPayloadV2(payload)` */
  signature: string;
  /** the normalized-configuration JSON — the `_imprintid_pricing_config` attribute; its
   * SHA-256 equals `payload.configDigest` */
  config: string;
}

export interface BuildCartPricingPayloadV2Args {
  result: PricingCalculationResult;
  currency: string;
  variantGid: string;
  productGid: string;
  enforcement: CartPricingEnforcementContext;
  /** normalized config JSON string (from `config-normalization.ts#normalizeConfig`) */
  normalizedConfigJson: string;
  /** `sha256:<hex>` digest of `normalizedConfigJson` */
  configDigest: string;
  /** unpredictable, generated in the application runtime */
  quoteId?: string;
  /** advisory only; signed but never clock-compared in a Function */
  now?: number;
}

/**
 * Builds the exact `CartPricingPayloadV2`, deriving prices from the already-computed
 * `PricingCalculationResult` (identical decomposition to `buildCartPricingPayload` v1 —
 * base / per-unit / flat), and binding identity + revisions strictly from the
 * server-resolved `enforcement` context. `lineTotalCents` is the reconstructed total
 * (`computeLineTotalCents`) so a Function can cross-check the expansion with one
 * comparison. Throws if the reconstructed total fails its own invariants (a bug, never
 * a client condition).
 */
export function buildCartPricingPayloadV2(args: BuildCartPricingPayloadV2Args): CartPricingPayloadV2 {
  const { result, currency, variantGid, productGid, enforcement } = args;

  let perUnitSurchargeCents = 0;
  let flatSurchargeCents = 0;
  if (result.decoration) {
    for (const line of result.decoration.charges) {
      if (line.chargeBasis === "PER_UNIT") perUnitSurchargeCents += line.netPriceCents;
      else flatSurchargeCents += line.netLineTotalCents;
    }
  }
  flatSurchargeCents += result.options.chargesCents;
  flatSurchargeCents += result.production.feeCents ?? 0;
  flatSurchargeCents += result.packaging?.feeCents ?? 0;
  flatSurchargeCents += result.productColor?.priceAdjustmentCents ?? 0;

  const components = {
    baseUnitPriceCents: result.base.netUnitPriceCents,
    perUnitSurchargeCents,
    flatSurchargeCents,
    quantity: result.quantity,
  };
  const lineTotalCents = computeLineTotalCents(components);

  const payload: CartPricingPayloadV2 = {
    v: ENVELOPE_V2,
    installBinding: enforcement.installBinding,
    productGid,
    variantGid,
    quantity: result.quantity,
    currency,
    baseUnitPriceCents: components.baseUnitPriceCents,
    perUnitSurchargeCents,
    flatSurchargeCents,
    lineTotalCents,
    adjustmentVariantGid: enforcement.adjustmentVariantGid,
    profileRef: enforcement.profileRef,
    profileRevision: enforcement.profileRevision,
    policyRevision: enforcement.policyRevision,
    configDigest: args.configDigest,
    quoteId: args.quoteId ?? randomUUID(),
    issuedAtServer: args.now ?? Math.floor(Date.now() / 1000),
  };

  const invariant = checkMonetaryInvariants(components, lineTotalCents);
  if (invariant !== null) {
    throw new Error(`buildCartPricingPayloadV2: monetary invariant failed (${invariant})`);
  }

  return payload;
}

export function signCartPricingPayloadV2(
  payload: CartPricingPayloadV2,
  normalizedConfigJson: string,
  secret: string,
): SignedCartPricingPayloadV2 {
  return {
    version: ENVELOPE_V2,
    payload: JSON.stringify(payload),
    signature: signHex(secret, canonicalizeCartPricingPayloadV2(payload)),
    config: normalizedConfigJson,
  };
}
