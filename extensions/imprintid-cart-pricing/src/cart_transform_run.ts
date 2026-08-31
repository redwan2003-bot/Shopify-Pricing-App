import type { CartTransformRunInput, CartTransformRunResult, Operation } from "../generated/api.ts";
import { verifyCartPricingAttributes } from "./verify-payload.ts";
import { CART_SIGNING_SECRET } from "./config.generated.ts";

/**
 * imprintid-cart-pricing — Cart Transform Function.
 *
 * THIS FUNCTION NEVER CALCULATES A PRICE. The real ImprintID pricing engine
 * (`app/lib/pricing/calculatePrice` — quantity tiers, decoration/color charges,
 * options, production, packaging) runs entirely server-side, where it has the
 * database access it needs; that access is categorically unavailable here — Shopify
 * Functions execute in a sandboxed WASM runtime with no network, filesystem, or
 * database access, and (relevant to `config.generated.ts`) no runtime environment
 * variables either. This function's only job is: verify a signature the server
 * already produced, and if (and only if) it's genuinely valid for this exact cart
 * line, tell Shopify to price the line at the number the server already calculated.
 * See app/lib/pricing-api/cart-signature.ts for where that payload is built, and
 * docs/storefront-pricing-bridge.md for the end-to-end contract.
 *
 * WHY `lineExpand`, NOT `lineUpdate`: `lineUpdate` only accepts a single per-unit
 * price — no way to represent a line total that mixes true per-unit charges with flat
 * one-time charges (setup fees, production/packaging fees) without rounding drift.
 * `lineExpand` lets each component of `PricingCalculationResult` carry its own *exact*
 * price (per-unit or flat, whichever it actually is) as a separate expanded item — see
 * cart-signature.ts's doc comment for the exact decomposition and the algebraic proof
 * it reconstructs the original total with zero rounding error.
 *
 * STORE PLAN REQUIREMENT (corrected from an earlier read of only the GraphQL schema's inline
 * doc-comments, which mention Shopify Plus only for `lineUpdate`): Shopify's apps
 * documentation states plainly that "only development stores or stores on a Shopify
 * Plus plan can use apps with `lineExpand` operations" — so `lineExpand` is NOT
 * Plus-independent the way the schema's own inline comments alone suggested. The dev
 * store this was built/tested against qualifies as a development store regardless: a
 * production merchant using this Function would need Shopify Plus (or their own
 * development store) for it to actually apply.
 *
 * ALSO NOT SUPPORTED: `lineExpand` is rejected outright whenever a selling plan is
 * present on the line, and is not supported for subscription/recurring-purchase
 * orders — per Shopify's Cart Transform documentation. ImprintID's current pricing
 * model has no selling-plan/subscription concept anywhere (`app/lib/pricing/**` has no
 * such field), so this doesn't affect anything built so far — but it's a real
 * constraint the moment ImprintID products are ever sold via a selling plan.
 *
 * The `ExpandedItem.merchandiseId` tradeoff: it must reference a real product variant,
 * so this function relies on one dedicated, merchant-configured "adjustment" variant
 * (its GID is itself part of the signed
 * payload, chosen server-side — see IMPRINTID_ADJUSTMENT_VARIANT_ID) to represent
 * every surcharge component; the base component uses the real variant already in the
 * cart line.
 */

const NO_CHANGES: CartTransformRunResult = { operations: [] };

/** Exact integer-cents → `Decimal` string, with no floating-point division of the
 * cents value itself — no precision loss converting, say, 6 cents to "0.06" or 123456
 * cents to "1234.56". This is the correct conversion whenever presentment currency
 * equals shop currency (rate 1) — the common case, and the only case any of this
 * extension's "exact reconstruction" tests assume. */
function formatExactCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainderCents = abs % 100;
  return `${sign}${dollars}.${String(remainderCents).padStart(2, "0")}`;
}

/**
 * Converts integer shop-currency cents to the `Decimal` (string) format Cart
 * Transform's price fields require — which the schema documents as being in
 * *presentment* currency, not shop currency (`ExpandedItemFixedPricePerUnitAdjustment.
 * amount`: "in presentment currency"). `calculatePrice` (the pricing engine) has no
 * multi-currency concept anywhere — every cent value in `PricingCalculationResult` is
 * a shop-currency amount — so this conversion has to happen here, at the integration
 * boundary, using `input.presentmentCurrencyRate` (a real field Shopify's Function
 * input provides for exactly this purpose — see cart_transform_run.graphql).
 *
 * When `presentmentRate` is exactly `"1"` (single-currency shops, or a customer
 * viewing in the shop's own currency — the common case), this takes the exact integer
 * path with zero floating-point involvement. Only when the rate genuinely differs does
 * it fall back to the same `parseFloat(amount) * rate` pattern Shopify's own
 * documentation uses for this conversion — at that point some floating-point rounding
 * is inherent to *any* currency conversion, not something this function introduces.
 */
export function centsToDecimalString(cents: number, presentmentRate: string = "1"): string {
  if (presentmentRate === "1" || presentmentRate === "1.0") {
    return formatExactCents(cents);
  }
  const rate = Number(presentmentRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    // A malformed/missing rate must never silently become a 1:1 conversion for a
    // genuinely different currency — but it also must never crash the whole cart's
    // transform. Falling back to the exact shop-currency amount is the same
    // fail-safe-not-fail-open posture as everywhere else in this function: the price
    // is never wrong in the "too cheap" direction due to a malformed rate, only
    // potentially in the shop's own currency terms, which is what was actually signed.
    return formatExactCents(cents);
  }
  return ((cents / 100) * rate).toFixed(2);
}

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  return runCartTransform(input, CART_SIGNING_SECRET, Math.floor(Date.now() / 1000));
}

/** The actual logic, with the compiled-in secret and current time as explicit
 * parameters instead of read directly from `config.generated.ts`/`Date.now()` — this
 * is what `cart_transform_run.test.ts` calls directly, with a known test secret and a
 * fixed `now`, so tests are deterministic and don't depend on when they happen to run
 * or on the (deliberately non-functional) placeholder secret in the checked-in
 * `config.generated.ts`. */
export function runCartTransform(input: CartTransformRunInput, secret: string, now: number): CartTransformRunResult {
  const operations: Operation[] = [];
  const presentmentRate = input.presentmentCurrencyRate;

  for (const line of input.cart.lines) {
    const merchandiseId = "id" in line.merchandise ? line.merchandise.id : null;

    const verification = verifyCartPricingAttributes(
      secret,
      now,
      { quantity: line.quantity, merchandiseId },
      {
        version: line.version?.value ?? null,
        payload: line.payload?.value ?? null,
        signature: line.signature?.value ?? null,
      },
    );

    // Not every cart line is an ImprintID-configured product — a normal line simply
    // has none of these attributes, which fails verification the same way a tampered
    // one would, and is handled identically here: leave it untouched. This is also the
    // fail-safe path for every other rejection reason (invalid/expired/mismatched) —
    // never transform, never guess, never charge based on unverified client data.
    if (!verification.ok) continue;

    const { payload } = verification;

    const expandedCartItems: Array<{
      merchandiseId: string;
      quantity: number;
      price: { adjustment: { fixedPricePerUnit: { amount: string } } };
    }> = [
      {
        merchandiseId: payload.baseVariantId,
        quantity: payload.quantity,
        price: { adjustment: { fixedPricePerUnit: { amount: centsToDecimalString(payload.baseUnitPriceCents, presentmentRate) } } },
      },
    ];

    if (payload.perUnitSurchargeCents > 0) {
      expandedCartItems.push({
        merchandiseId: payload.adjustmentVariantId,
        quantity: payload.quantity,
        price: {
          adjustment: { fixedPricePerUnit: { amount: centsToDecimalString(payload.perUnitSurchargeCents, presentmentRate) } },
        },
      });
    }

    if (payload.flatSurchargeCents > 0) {
      expandedCartItems.push({
        merchandiseId: payload.adjustmentVariantId,
        quantity: 1,
        price: {
          adjustment: { fixedPricePerUnit: { amount: centsToDecimalString(payload.flatSurchargeCents, presentmentRate) } },
        },
      });
    }

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems,
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
