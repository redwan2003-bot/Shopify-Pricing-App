import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expectedExpandedComponents,
  hasComponentMultisetMismatch,
  componentKey,
  type ExpectedComponent,
} from "./expanded-components.ts";
import type { CartPricingPayloadV2 } from "./cart-pricing-contract.ts";

const ADJ = "gid://shopify/ProductVariant/999";
const VAR = "gid://shopify/ProductVariant/2";

function payload(over: Partial<CartPricingPayloadV2> = {}): CartPricingPayloadV2 {
  return {
    v: 2, installBinding: "i", productGid: "gid://shopify/Product/1", variantGid: VAR, quantity: 100, currency: "USD",
    baseUnitPriceCents: 137, perUnitSurchargeCents: 20, flatSurchargeCents: 4500,
    lineTotalCents: 137 * 100 + 20 * 100 + 4500,
    adjustmentVariantGid: ADJ, profileRef: "p", profileRevision: 1, policyRevision: 1,
    configDigest: "sha256:x", quoteId: "q", issuedAtServer: 1, ...over,
  };
}

const EXPECTED = (): ExpectedComponent[] => expectedExpandedComponents(payload()); // base + combined surcharge

// ---------------------------------------------------------------------------
// hasComponentMultisetMismatch — semantics: `true` ⇔ THERE IS a mismatch
// ---------------------------------------------------------------------------

test("componentKey: an unparseable (null) per-unit amount can never equal a real key", () => {
  assert.notEqual(componentKey({ merchandiseGid: VAR, quantity: 1, perUnitCents: null }), componentKey({ merchandiseGid: VAR, quantity: 1, perUnitCents: 0 }));
});

test("EXACT match (same items) → false (no mismatch)", () => {
  const observed = EXPECTED().map((c) => ({ merchandiseGid: c.merchandiseGid, quantity: c.quantity, perUnitCents: c.perUnitCents }));
  assert.equal(hasComponentMultisetMismatch(EXPECTED(), observed), false);
});

test("SAME items, DIFFERENT ORDER → false (order-independent)", () => {
  const observed = EXPECTED()
    .map((c) => ({ merchandiseGid: c.merchandiseGid, quantity: c.quantity, perUnitCents: c.perUnitCents }))
    .reverse();
  assert.equal(hasComponentMultisetMismatch(EXPECTED(), observed), false);
});

test("DUPLICATE component → true", () => {
  const base = EXPECTED();
  const observed = [...base, base[1]!].map((c) => ({ merchandiseGid: c.merchandiseGid, quantity: c.quantity, perUnitCents: c.perUnitCents }));
  assert.equal(hasComponentMultisetMismatch(base, observed), true);
});

test("MISSING component → true", () => {
  const base = EXPECTED();
  const observed = base.slice(0, 1).map((c) => ({ merchandiseGid: c.merchandiseGid, quantity: c.quantity, perUnitCents: c.perUnitCents }));
  assert.equal(hasComponentMultisetMismatch(base, observed), true);
});

test("EXTRA component → true", () => {
  const base = EXPECTED();
  const observed = [
    ...base.map((c) => ({ merchandiseGid: c.merchandiseGid, quantity: c.quantity, perUnitCents: c.perUnitCents })),
    { merchandiseGid: ADJ, quantity: 5, perUnitCents: 111 },
  ];
  assert.equal(hasComponentMultisetMismatch(base, observed), true);
});

test("CHANGED quantity → true", () => {
  const base = EXPECTED();
  const observed = base.map((c, i) => ({ merchandiseGid: c.merchandiseGid, quantity: i === 0 ? c.quantity + 1 : c.quantity, perUnitCents: c.perUnitCents }));
  assert.equal(hasComponentMultisetMismatch(base, observed), true);
});

test("CHANGED cents → true", () => {
  const base = EXPECTED();
  const observed = base.map((c, i) => ({ merchandiseGid: c.merchandiseGid, quantity: c.quantity, perUnitCents: i === 1 ? c.perUnitCents - 1 : c.perUnitCents }));
  assert.equal(hasComponentMultisetMismatch(base, observed), true);
});

test("CHANGED merchandise → true", () => {
  const base = EXPECTED();
  const observed = base.map((c, i) => ({ merchandiseGid: i === 0 ? "gid://shopify/ProductVariant/other" : c.merchandiseGid, quantity: c.quantity, perUnitCents: c.perUnitCents }));
  assert.equal(hasComponentMultisetMismatch(base, observed), true);
});

test("NULL per-unit amount anywhere → true", () => {
  const base = EXPECTED();
  const observed = base.map((c, i) => ({ merchandiseGid: c.merchandiseGid, quantity: c.quantity, perUnitCents: i === 1 ? null : c.perUnitCents }));
  assert.equal(hasComponentMultisetMismatch(base, observed), true);
});

// ---------------------------------------------------------------------------
// expectedExpandedComponents — zero surcharges omitted
// ---------------------------------------------------------------------------

test("expectedExpandedComponents: base-only when both surcharges are zero", () => {
  const comps = expectedExpandedComponents(payload({ perUnitSurchargeCents: 0, flatSurchargeCents: 0 }));
  assert.deepEqual(comps, [{ merchandiseGid: VAR, quantity: 100, perUnitCents: 137, kind: "base" }]);
});

test("expectedExpandedComponents: base + surcharge when the total surcharge is non-zero", () => {
  const comps = expectedExpandedComponents(payload({ perUnitSurchargeCents: 0, flatSurchargeCents: 4500 }));
  assert.deepEqual(comps.map((c) => c.kind), ["base", "surcharge"]);
  assert.equal(comps[1]!.quantity, 1);
});
