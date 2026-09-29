import type { CartTransformRunInput, CartTransformRunResult, Operation } from "../generated/api.ts";
import { verifyCartPricingAttributes } from "./verify-payload.ts";
import {
  verifyCartPricingAttributesV2,
  parseShopEnforcementPolicy,
  parseProductPricingPolicy,
  type ShopEnforcementPolicy,
  type ProductPricingPolicy,
} from "./verify-payload-v2.ts";
import { CART_SIGNING_SECRET } from "./config.generated.ts";

/**
 * imprintid-cart-pricing — Cart Transform Function (Task 5B.1 / 5B.1.1 hardened).
 *
 * THIS FUNCTION NEVER CALCULATES A PRICE. It verifies a signature the server already
 * produced and — if (and only if) it is genuinely valid for this exact cart line against
 * **Shopify-owned** policy data — expands the line at the numbers the server calculated.
 *
 * 5B.3B.2 CHANGES:
 *  - **Currency is mandatory and never converted.** An enforced v2 line is expanded only
 *    when Shopify's own cart-line currency equals the signed quote currency AND the
 *    presentment rate is par (1:1). A missing cart currency or any mismatch yields NO
 *    operation (the Validation Function then blocks the line). NO foreign-exchange math
 *    is ever applied to a v2 quote.
 *
 * 5B.1.1 CHANGES:
 *  - **No implicit legacy mode.** A missing / malformed / incomplete / unsupported shop
 *    `enforcement_policy` metafield now yields **NO operation** — it is NEVER treated as
 *    "backward compatibility". Legacy v1 is authorized ONLY by an explicit
 *    `allowLegacyV1: true` on a valid `pilot`-mode shop policy.
 *  - Input is typed by the **generated** `CartTransformRunInput`
 *    (`shopify app function typegen` over `cart_transform_run.graphql`). It is validated
 *    into a small internal `NormalizedTransformInput` before any logic runs — no `any`,
 *    no invented interface for the whole input.
 *
 * 5B.1 CHANGES (retained):
 *  - NO CLOCK anywhere. `Date.now()` / injected `now` / `expiresAt` comparisons removed.
 *  - Envelope v2 bound to the app-owned shop + product policy metafields; replay/expiry
 *    is revision-bound (`profileRevision` / `policyRevision`), not clock-bound.
 *  - Policy modes: `disabled` / `pilot` / `universal` / `maintenance`.
 *
 * IMPORTANT LIMITATION: a Cart Transform CANNOT return a customer-blocking error. An
 * invalid/missing/absent-policy quote produces NO pricing operation → the line keeps its
 * **native price** until the Cart & Checkout Validation Function (Task 5B.2) is
 * generated, implemented, and activated. Because of this residual native-price exposure,
 * cart signing and enforced rollout must remain disabled until Validation is live.
 */

const NO_CHANGES: CartTransformRunResult = { operations: [] };

/** Task 5B.3B.2 — an enforced v2 line is only ever expanded at PAR. No foreign-exchange
 * conversion is ever performed on a signed quote (see the v2 branch of `runCartTransform`
 * and `verifyCartPricingAttributesV2`'s mandatory currency check). */
const PAR_RATE = "1";

/** Whether Shopify's `presentmentCurrencyRate` describes a par (1:1) conversion. A
 * malformed rate is NOT par → fail closed. */
export function isParPresentmentRate(rate: string): boolean {
  const n = Number(rate);
  return Number.isFinite(n) && n === 1;
}

// ---------------------------------------------------------------------------
// Money formatting (unchanged)
// ---------------------------------------------------------------------------

function formatExactCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainderCents = abs % 100;
  return `${sign}${dollars}.${String(remainderCents).padStart(2, "0")}`;
}

export function centsToDecimalString(cents: number, presentmentRate: string = "1"): string {
  if (presentmentRate === "1" || presentmentRate === "1.0") return formatExactCents(cents);
  const rate = Number(presentmentRate);
  if (!Number.isFinite(rate) || rate <= 0) return formatExactCents(cents);
  return ((cents / 100) * rate).toFixed(2);
}

/** Expanded quantities are per parent bundle unit. Spread the signed line
 * surcharge over that unit so Shopify's multiplication preserves the total. */
export function centsPerBundleToDecimalString(
  totalCents: number,
  bundleQuantity: number,
  presentmentRate: string = "1",
): string {
  if (!Number.isFinite(totalCents) || !Number.isFinite(bundleQuantity) || bundleQuantity <= 0) return "0.00";
  const rate = Number(presentmentRate);
  const appliedRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return ((totalCents / bundleQuantity / 100) * appliedRate).toFixed(8);
}

// ---------------------------------------------------------------------------
// Validated normalization of the generated Function input
// ---------------------------------------------------------------------------

/** The signed-quote line attributes, as strings-or-null. */
export interface LineAttrs {
  version: string | null;
  payload: string | null;
  signature: string | null;
  config: string | null;
}

/** A cart line after validated extraction from `CartTransformRunInput`. Small, internal,
 * and only produced by `normalizeTransformInput` — never a cast of the raw input. */
export interface NormalizedLine {
  id: string;
  quantity: number;
  merchandiseId: string | null;
  productGid: string | null;
  productPolicyJson: unknown;
  currencyCode: string | null;
  attrs: LineAttrs;
}

export interface NormalizedTransformInput {
  presentmentRate: string;
  /** Raw `jsonValue` of the shop `$app:imprintid/enforcement_policy` metafield (parsed
   * strictly downstream). `null` when absent. */
  shopPolicyJson: unknown;
  lines: NormalizedLine[];
}

function attrValue(a: { value?: string | null } | null | undefined): string | null {
  return a && typeof a.value === "string" ? a.value : null;
}

export function normalizeTransformInput(input: CartTransformRunInput): NormalizedTransformInput {
  const lines: NormalizedLine[] = input.cart.lines.map((line) => {
    const merch = line.merchandise;
    // Task 5B.3B.8 — ProductVariant identity is taken ONLY from the GraphQL `__typename`
    // discriminant, never inferred from the presence of `id` / `product` / a SKU. The
    // input query (`cart_transform_run.graphql`) MUST request `merchandise { __typename }`
    // for this to be meaningful; a missing/unknown discriminator yields a non-variant
    // line (all identity fields `null`) and the enforced path is never reached — fail
    // closed. (A prior build omitted `__typename` from the query, which disabled all
    // enforcement; see `cart-transform-typename-5b3b8.test.ts`.)
    const isVariant = merch.__typename === "ProductVariant";
    const merchandiseId = isVariant ? merch.id : null;
    const productGid = isVariant ? merch.product.id : null;
    const productPolicyJson = isVariant ? (merch.product.pricingPolicy?.jsonValue ?? null) : null;
    const currencyCode =
      line.cost.amountPerQuantity.currencyCode ?? line.cost.totalAmount.currencyCode ?? null;
    return {
      id: line.id,
      quantity: line.quantity,
      merchandiseId,
      productGid,
      productPolicyJson,
      currencyCode: currencyCode === null || currencyCode === undefined ? null : String(currencyCode),
      attrs: {
        version: attrValue(line.version),
        payload: attrValue(line.payload),
        signature: attrValue(line.signature),
        config: attrValue(line.config),
      },
    };
  });

  return {
    presentmentRate: input.presentmentCurrencyRate,
    shopPolicyJson: input.shop.enforcementPolicy?.jsonValue ?? null,
    lines,
  };
}

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  return runCartTransform(normalizeTransformInput(input), CART_SIGNING_SECRET);
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

interface ExpandedCartItem {
  merchandiseId: string;
  quantity: number;
  price: { adjustment: { fixedPricePerUnit: { amount: string } } };
}

function priceAdjustment(amount: string): ExpandedCartItem["price"] {
  return { adjustment: { fixedPricePerUnit: { amount } } };
}

function buildExpandedItems(
  payload: {
    baseVariantId: string;
    quantity: number;
    baseUnitPriceCents: number;
    perUnitSurchargeCents: number;
    flatSurchargeCents: number;
    adjustmentVariantId: string;
  },
  presentmentRate: string,
): ExpandedCartItem[] {
  const items: ExpandedCartItem[] = [
    {
      merchandiseId: payload.baseVariantId,
      quantity: 1,
      price: priceAdjustment(centsToDecimalString(payload.baseUnitPriceCents, presentmentRate)),
    },
  ];
  const surchargeTotal = payload.perUnitSurchargeCents * payload.quantity + payload.flatSurchargeCents;
  if (surchargeTotal > 0) {
    items.push({
      merchandiseId: payload.adjustmentVariantId,
      quantity: 1,
      price: priceAdjustment(centsPerBundleToDecimalString(surchargeTotal, payload.quantity, presentmentRate)),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Enforcement decision
// ---------------------------------------------------------------------------

/** Whether a v2 line is subject to enforcement, given the mode + product policy. */
function isV2Enforced(mode: ShopEnforcementPolicy["mode"], productPolicy: ProductPricingPolicy | null): boolean {
  switch (mode) {
    case "disabled":
      return false;
    case "pilot":
      return !!productPolicy && productPolicy.required && productPolicy.active;
    case "universal":
      return true;
    case "maintenance":
      return !!productPolicy && productPolicy.required;
  }
}

/** Whether a legacy v1 quote may be processed for this line. v1 is authorized ONLY by an
 * explicit `allowLegacyV1: true` on a `pilot`-mode policy, and ONLY for a line whose
 * product is in the pilot (active `required` policy). Never in `universal` / `maintenance`
 * / `disabled`, and never without a valid shop policy. */
function isV1Allowed(policy: ShopEnforcementPolicy, productPolicy: ProductPricingPolicy | null): boolean {
  if (policy.mode !== "pilot") return false;
  if (policy.allowLegacyV1 !== true) return false;
  return !!productPolicy && productPolicy.required && productPolicy.active;
}

export function runCartTransform(input: NormalizedTransformInput, secret: string): CartTransformRunResult {
  const operations: Operation[] = [];
  const { presentmentRate } = input;

  // 5B.1.1: a missing OR malformed shop policy fails CLOSED — NO operations. There is no
  // implicit legacy mode. (`parseShopEnforcementPolicy` returns `null` for both cases.)
  const policy = parseShopEnforcementPolicy(input.shopPolicyJson);
  if (policy === null) return NO_CHANGES;

  // Kill switch / intentionally-off / incident rollback ⇒ emit nothing.
  if (!policy.enabled || policy.mode === "disabled" || policy.mode === "maintenance") {
    return NO_CHANGES;
  }

  for (const line of input.lines) {
    // Adjustment-variant protection: never expand a cart LINE that IS the adjustment
    // variant (the Transform only ever introduces it as an expanded *component*).
    if (line.merchandiseId && line.merchandiseId === policy.adjustmentVariantGid) continue;

    const productPolicy = parseProductPricingPolicy(line.productPolicyJson);

    if (line.attrs.version === "2") {
      if (!isV2Enforced(policy.mode, productPolicy)) continue;
      // universal with a missing/inactive product policy: nothing authoritative to price
      // against — no operation; classified for the Validation Function to block.
      if (!productPolicy || !productPolicy.active) continue;

      // Task 5B.3B.2 — NO FX. An enforced v2 line is expanded only at par. The server
      // signs a quote only when the profile currency equals the shop currency, and
      // `verifyCartPricingAttributesV2` below requires the cart line's own currency to
      // equal the signed currency — so a non-par presentment rate cannot describe a
      // line this quote legitimately applies to. Refuse rather than convert.
      if (!isParPresentmentRate(presentmentRate)) continue;

      const verification = verifyCartPricingAttributesV2(
        secret,
        {
          quantity: line.quantity,
          variantGid: line.merchandiseId,
          productGid: line.productGid,
          currencyCode: line.currencyCode,
        },
        line.attrs,
        policy,
        productPolicy,
      );
      if (!verification.ok) continue;

      const p = verification.payload;
      operations.push({
        lineExpand: {
          cartLineId: line.id,
          expandedCartItems: buildExpandedItems(
            {
              baseVariantId: p.variantGid,
              quantity: p.quantity,
              baseUnitPriceCents: p.baseUnitPriceCents,
              perUnitSurchargeCents: p.perUnitSurchargeCents,
              flatSurchargeCents: p.flatSurchargeCents,
              adjustmentVariantId: p.adjustmentVariantGid,
            },
            PAR_RATE,
          ),
        },
      });
      continue;
    }

    // ---- v1 (legacy) — only under an explicit pilot + allowLegacyV1 authorization ----
    if (!isV1Allowed(policy, productPolicy)) continue;

    const v1 = verifyCartPricingAttributes(
      secret,
      { quantity: line.quantity, merchandiseId: line.merchandiseId },
      { version: line.attrs.version, payload: line.attrs.payload, signature: line.attrs.signature },
    );
    if (!v1.ok) continue;

    const pl = v1.payload;
    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems: buildExpandedItems(
          {
            baseVariantId: pl.baseVariantId,
            quantity: pl.quantity,
            baseUnitPriceCents: pl.baseUnitPriceCents,
            perUnitSurchargeCents: pl.perUnitSurchargeCents,
            flatSurchargeCents: pl.flatSurchargeCents,
            adjustmentVariantId: pl.adjustmentVariantId,
          },
          presentmentRate,
        ),
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
