import type { PrismaClient } from "@prisma/client";
import { handlePricingApiRequest } from "./handler.ts";
import type { ApiErrorBody } from "./types.ts";
import type { PricingCalculationResult } from "../pricing/index.ts";
import { buildCartPricingPayload, signCartPricingPayload } from "./cart-signature.ts";
import type { SignedCartPricingPayload } from "./cart-signature.ts";

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
 */
export type StorefrontPricingData = Omit<PricingCalculationResult, "source"> & {
  cartPricing: SignedCartPricingPayload | null;
};

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
export async function handleStorefrontPricingRequest(
  prisma: PrismaClient,
  shopDomain: string,
  rawBody: unknown,
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
  } = result.body.data;

  const cartPricing = await buildSignedCartPricingIfRequested(prisma, rawBody, result.body.data);

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
      },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
