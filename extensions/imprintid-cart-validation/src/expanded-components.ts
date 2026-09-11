import type { CartPricingPayloadV2 } from "./cart-pricing-contract.ts";

/**
 * The expanded-component multiset a validated v2 quote implies, derived EXACTLY from
 * `extensions/imprintid-cart-pricing/src/cart_transform_run.ts#buildExpandedItems`:
 *
 *   base component      : merchandise = base variant,       quantity = payload.quantity, per-unit = baseUnitPriceCents
 *   per-unit surcharge  : merchandise = adjustment variant, quantity = payload.quantity, per-unit = perUnitSurchargeCents  (only if > 0)
 *   flat surcharge      : merchandise = adjustment variant, quantity = 1,                per-unit = flatSurchargeCents      (only if > 0)
 *
 * `drift.test.ts` cross-checks `expectedExpandedComponents` against the Cart Transform's
 * real `runCartTransform` output for every golden vector, so the two cannot drift.
 */

export type ExpectedComponentKind = "base" | "per_unit" | "flat";

export interface ExpectedComponent {
  merchandiseGid: string;
  quantity: number;
  /** the `fixedPricePerUnit` amount, in integer cents */
  perUnitCents: number;
  kind: ExpectedComponentKind;
}

export function expectedExpandedComponents(p: CartPricingPayloadV2): ExpectedComponent[] {
  const out: ExpectedComponent[] = [
    { merchandiseGid: p.variantGid, quantity: p.quantity, perUnitCents: p.baseUnitPriceCents, kind: "base" },
  ];
  if (p.perUnitSurchargeCents > 0) {
    out.push({ merchandiseGid: p.adjustmentVariantGid, quantity: p.quantity, perUnitCents: p.perUnitSurchargeCents, kind: "per_unit" });
  }
  if (p.flatSurchargeCents > 0) {
    out.push({ merchandiseGid: p.adjustmentVariantGid, quantity: 1, perUnitCents: p.flatSurchargeCents, kind: "flat" });
  }
  return out;
}

/** A stable multiset key for one component: merchandise + quantity + per-unit cents.
 * A `null` per-unit amount produces a key that can never equal any expected key, so an
 * unparseable component always registers as a mismatch. */
export function componentKey(c: { merchandiseGid: string; quantity: number; perUnitCents: number | null }): string {
  return `${c.merchandiseGid}|q=${c.quantity}|c=${c.perUnitCents === null ? "∅" : c.perUnitCents}`;
}

/**
 * Whether an OBSERVED component multiset does NOT exactly equal the EXPECTED one.
 *
 *   returns `false`  ⇔  the two multisets are equal — order-independent,
 *                       multiplicity-sensitive (each `{merchandise, quantity, cents}`
 *                       tuple appears the same number of times on both sides);
 *   returns `true`   ⇔  ANY of: different component count, a missing component, an extra
 *                       component, a duplicate, an altered merchandise / quantity / cents,
 *                       or an unparseable (`null`) per-unit amount.
 *
 * Name states the return meaning directly: `true` = there IS a mismatch.
 */
export function hasComponentMultisetMismatch(
  expected: ExpectedComponent[],
  observed: Array<{ merchandiseGid: string; quantity: number; perUnitCents: number | null }>,
): boolean {
  if (observed.length !== expected.length) return true;
  const e = expected.map(componentKey).sort();
  const o = observed.map(componentKey).sort();
  for (let i = 0; i < e.length; i++) if (e[i] !== o[i]) return true;
  return false;
}
