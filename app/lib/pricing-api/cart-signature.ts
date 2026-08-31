import { signHex } from "./hmac-sha256.ts";
import type { PricingCalculationResult } from "../pricing/index.ts";

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
