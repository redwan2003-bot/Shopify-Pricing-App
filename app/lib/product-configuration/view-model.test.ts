import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDefaultConfigurationState,
  buildCalculationRequestBody,
  buildCalculationFingerprint,
  buildQuoteSummary,
  buildSelectedConfigurationRows,
  formatListRateLabel,
  productConfigurationShouldRevalidate,
  selectAttachmentGroups,
  selectFeatureGroups,
  selectGenericGroups,
  shouldSubmitCalculation,
} from "./view-model.ts";
import type { PricingCatalog, PricingCatalogOptionGroup } from "../pricing-api/catalog.ts";
import type { PricingCalculationResult } from "../pricing/index.ts";
import type { ProductConfigurationState } from "./types.ts";

function buildCatalog(overrides: Partial<PricingCatalog> = {}): PricingCatalog {
  return {
    sku: "LNY01",
    // Task 4A: the admin product-configuration preview never supplies Shopify
    // product/variant ids, so a real `loadPricingCatalog` call here returns `null`.
    identity: null,
    quantityTiers: [
      { minQuantity: 1000, maxQuantity: 2999, priceCode: null, listUnitPriceCents: 164, netUnitPriceCents: 98 },
      { minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 },
    ],
    productColors: [],
    decorationMethods: ["SCREEN_PRINT"],
    decorationCapabilities: [
      { method: "SCREEN_PRINT", maxColors: 2, secondLocation: true, reverseSide: true, repeatOrder: true },
    ],
    decorationColorCharges: [],
    optionGroups: [
      { name: "Attachment — Standard", kind: "ATTACHMENT", isRequired: false, categoryPriceAdjustmentCents: 0, values: [] },
      { name: "Optional Features", kind: "FEATURE", isRequired: false, categoryPriceAdjustmentCents: null, values: [] },
      { name: "Misc", kind: "GENERIC", isRequired: false, categoryPriceAdjustmentCents: null, values: [] },
    ],
    productionRules: [
      { code: "STANDARD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null },
      { code: "RUSH", name: "Rush", isRush: true, minBusinessDays: 5, maxBusinessDays: 5, relatedSku: null, feeCents: null, notes: null },
    ],
    ...overrides,
  };
}

test("buildDefaultConfigurationState picks the lowest quantity tier regardless of catalog order", () => {
  const state = buildDefaultConfigurationState(buildCatalog());
  assert.equal(state.quantity, 100);
});

test("buildDefaultConfigurationState falls back to quantity 1 with no tiers configured", () => {
  const state = buildDefaultConfigurationState(buildCatalog({ quantityTiers: [] }));
  assert.equal(state.quantity, 1);
});

test("buildDefaultConfigurationState picks the sole non-rush production rule as default", () => {
  const state = buildDefaultConfigurationState(buildCatalog());
  assert.equal(state.productionCode, "STANDARD");
});

test("buildDefaultConfigurationState leaves production unset when the non-rush default is ambiguous", () => {
  const state = buildDefaultConfigurationState(
    buildCatalog({
      productionRules: [
        { code: "A", name: "A", isRush: false, minBusinessDays: 1, maxBusinessDays: null, relatedSku: null, feeCents: null, notes: null },
        { code: "B", name: "B", isRush: false, minBusinessDays: 1, maxBusinessDays: null, relatedSku: null, feeCents: null, notes: null },
      ],
    }),
  );
  assert.equal(state.productionCode, null);
});

test("buildDefaultConfigurationState never invents a product color or option selection", () => {
  const state = buildDefaultConfigurationState(buildCatalog());
  assert.equal(state.productColorCode, null);
  assert.deepEqual(state.selectedOptionValueIds, {});
});

test("buildCalculationRequestBody omits decoration/production/options entirely when unset", () => {
  const state: ProductConfigurationState = {
    quantity: 500,
    decorationMethod: null,
    colors: 1,
    locations: 1,
    reverseSide: false,
    differentReverseArtwork: false,
    repeatOrder: false,
    productColorCode: null,
    selectedOptionValueIds: {},
    productionCode: null,
  };
  const body = buildCalculationRequestBody("LNY01", state);
  assert.equal(body.sku, "LNY01");
  assert.equal(body.quantity, 500);
  assert.equal(body.decoration, undefined);
  assert.equal(body.production, undefined);
  assert.equal(body.options, undefined);
  assert.equal(body.productColor, undefined);
});

test("buildCalculationRequestBody maps a fully-configured state to the calculation input shape", () => {
  const state: ProductConfigurationState = {
    quantity: 1000,
    decorationMethod: "SCREEN_PRINT",
    colors: 2,
    locations: 2,
    reverseSide: true,
    differentReverseArtwork: true,
    repeatOrder: true,
    productColorCode: "ROYAL",
    selectedOptionValueIds: { "Optional Features": "opt-123" },
    productionCode: "RUSH",
  };
  const body = buildCalculationRequestBody("LNY01", state);
  assert.deepEqual(body.productColor, { code: "ROYAL" });
  assert.deepEqual(body.decoration, {
    method: "SCREEN_PRINT",
    colors: 2,
    locations: 2,
    reverseSide: true,
    differentReverseArtwork: true,
    repeatOrder: true,
  });
  assert.deepEqual(body.options, [{ groupName: "Optional Features", optionValueId: "opt-123" }]);
  assert.deepEqual(body.production, { code: "RUSH" });
});

test("buildCalculationRequestBody clears differentReverseArtwork when reverseSide is off, even if state carries a stale true", () => {
  const state: ProductConfigurationState = {
    quantity: 100,
    decorationMethod: "SCREEN_PRINT",
    colors: 1,
    locations: 1,
    reverseSide: false,
    differentReverseArtwork: true,
    repeatOrder: false,
    productColorCode: null,
    selectedOptionValueIds: {},
    productionCode: "STANDARD",
  };
  const body = buildCalculationRequestBody("LNY01", state);
  assert.equal((body.decoration as { differentReverseArtwork: boolean }).differentReverseArtwork, false);
});

test("selectAttachmentGroups/selectFeatureGroups/selectGenericGroups partition by kind without dropping any group", () => {
  const catalog = buildCatalog();
  const attachments = selectAttachmentGroups(catalog);
  const features = selectFeatureGroups(catalog);
  const generic = selectGenericGroups(catalog);
  assert.equal(attachments.length, 1);
  assert.equal(features.length, 1);
  assert.equal(generic.length, 1);
  assert.equal(attachments.length + features.length + generic.length, catalog.optionGroups.length);
});

// ============================================================================
// Product Configuration recalculation-loop fix
// ============================================================================

function baseState(): ProductConfigurationState {
  return {
    quantity: 100,
    decorationMethod: "SCREEN_PRINT",
    colors: 1,
    locations: 1,
    reverseSide: false,
    differentReverseArtwork: false,
    repeatOrder: false,
    productColorCode: null,
    selectedOptionValueIds: {},
    productionCode: "STANDARD",
  };
}

/** Minimal in-memory model of the route effect: a fingerprint + a ref of what was last
 * submitted. `tick` returns whether a submission fires and updates the ref exactly as
 * the real effect does (mark BEFORE submit). */
function makeSubmitter() {
  const ref: { last: string | null } = { last: null };
  return {
    tick(sku: string, state: ProductConfigurationState, ready = true): "submit" | "skip" {
      const fingerprint = buildCalculationFingerprint(sku, state);
      if (!shouldSubmitCalculation({ ready, fingerprint, lastSubmittedFingerprint: ref.last })) return "skip";
      ref.last = fingerprint; // effect marks the ref at submit time
      return "submit";
    },
    lastSubmitted: () => ref.last,
  };
}

test("fingerprint: identical inputs -> identical fingerprint (object identity / key order irrelevant)", () => {
  const a = baseState();
  const b: ProductConfigurationState = {
    ...baseState(),
    selectedOptionValueIds: { "Group B": "v2", "Group A": "v1" },
  };
  const c: ProductConfigurationState = {
    ...baseState(),
    selectedOptionValueIds: { "Group A": "v1", "Group B": "v2" },
  };
  assert.equal(buildCalculationFingerprint("LNY01", a), buildCalculationFingerprint("LNY01", { ...baseState() }));
  assert.equal(buildCalculationFingerprint("LNY01", b), buildCalculationFingerprint("LNY01", c), "option key order must not matter");
});

test("fingerprint: any real pricing input change -> a different fingerprint", () => {
  const base = buildCalculationFingerprint("LNY01", baseState());
  assert.notEqual(base, buildCalculationFingerprint("LNY01", { ...baseState(), quantity: 250 }));
  assert.notEqual(base, buildCalculationFingerprint("LNY01", { ...baseState(), colors: 2 }));
  assert.notEqual(base, buildCalculationFingerprint("LNY01", { ...baseState(), locations: 2 }));
  assert.notEqual(base, buildCalculationFingerprint("LNY01", { ...baseState(), reverseSide: true }));
  assert.notEqual(base, buildCalculationFingerprint("LNY01", { ...baseState(), repeatOrder: true }));
  assert.notEqual(base, buildCalculationFingerprint("LNY01", { ...baseState(), productColorCode: "BLACK" }));
  assert.notEqual(base, buildCalculationFingerprint("LNY01", { ...baseState(), productionCode: "RUSH" }));
  assert.notEqual(base, buildCalculationFingerprint("LNY01", { ...baseState(), selectedOptionValueIds: { G: "v" } }));
  assert.notEqual(base, buildCalculationFingerprint("OTHER", baseState()));
});

test("loop-fix 1: an initial valid configuration submits exactly once", () => {
  const s = makeSubmitter();
  assert.equal(s.tick("LNY01", baseState()), "submit");
  assert.equal(s.tick("LNY01", baseState()), "skip", "no second submit for the same inputs");
});

test("loop-fix 2: a successful response (inputs unchanged) does not resubmit", () => {
  const s = makeSubmitter();
  s.tick("LNY01", baseState()); // initial
  // response arrives -> component rerenders with the SAME inputs
  assert.equal(s.tick("LNY01", { ...baseState() }), "skip");
  assert.equal(s.tick("LNY01", { ...baseState() }), "skip");
});

test("loop-fix 3: a rerender with identical inputs (new object identity) does not submit", () => {
  const s = makeSubmitter();
  s.tick("LNY01", baseState());
  for (let i = 0; i < 20; i++) {
    assert.equal(s.tick("LNY01", { ...baseState(), selectedOptionValueIds: { ...baseState().selectedOptionValueIds } }), "skip");
  }
});

test("loop-fix 4: one option change submits exactly once", () => {
  const s = makeSubmitter();
  s.tick("LNY01", baseState());
  assert.equal(s.tick("LNY01", { ...baseState(), quantity: 300 }), "submit");
  assert.equal(s.tick("LNY01", { ...baseState(), quantity: 300 }), "skip");
});

test("loop-fix 5: rapid changes calculate only the latest state", () => {
  const s = makeSubmitter();
  s.tick("LNY01", baseState());
  // The debounce only ever runs the LAST fingerprint; intermediate states never submit.
  // Model: only the final state is ticked (earlier timers were cleared).
  const finalState = { ...baseState(), quantity: 500, colors: 2 as const, productionCode: "RUSH" };
  assert.equal(s.tick("LNY01", finalState), "submit");
  assert.equal(s.lastSubmitted(), buildCalculationFingerprint("LNY01", finalState));
  // An intermediate fingerprint is never what got submitted.
  assert.notEqual(s.lastSubmitted(), buildCalculationFingerprint("LNY01", { ...baseState(), quantity: 500 }));
});

test("loop-fix 6: while a request for a fingerprint is active, an identical concurrent request is not started", () => {
  const s = makeSubmitter();
  assert.equal(s.tick("LNY01", baseState()), "submit"); // marks ref at submit time
  // request still in flight; component rerenders (e.g. outcome -> loading)
  assert.equal(s.tick("LNY01", baseState()), "skip");
  assert.equal(s.tick("LNY01", baseState()), "skip");
});

test("loop-fix 7: an error response does not create a retry loop", () => {
  const s = makeSubmitter();
  s.tick("LNY01", baseState()); // submitted; server returns an error
  // No input changed -> fingerprint unchanged -> never resubmits.
  for (let i = 0; i < 50; i++) assert.equal(s.tick("LNY01", { ...baseState() }), "skip");
  // ...until the user actually changes something.
  assert.equal(s.tick("LNY01", { ...baseState(), quantity: 999 }), "submit");
});

test("loop-fix 8: not-ready never submits; readiness alone does not resubmit an unchanged fingerprint", () => {
  const s = makeSubmitter();
  assert.equal(s.tick("LNY01", baseState(), false), "skip", "not ready");
  assert.equal(s.tick("LNY01", baseState(), true), "submit", "first ready render submits once");
  assert.equal(s.tick("LNY01", baseState(), true), "skip");
});

test("loop-fix 8b: shouldSubmitCalculation rejects an empty fingerprint outright", () => {
  assert.equal(shouldSubmitCalculation({ ready: true, fingerprint: "", lastSubmittedFingerprint: null }), false);
});

test("loop-fix 9: shouldRevalidate never revalidates the loader on a POST (no Admin refetch, no shop:null)", () => {
  assert.equal(productConfigurationShouldRevalidate("POST", true), false);
  assert.equal(productConfigurationShouldRevalidate("post", true), false);
  // real navigations still defer to React Router's default
  assert.equal(productConfigurationShouldRevalidate(undefined, true), true);
  assert.equal(productConfigurationShouldRevalidate(undefined, false), false);
  assert.equal(productConfigurationShouldRevalidate("GET", true), true);
});

test("loop-fix 9b: the calculation request body never carries a shop / shopDomain (server sources it from the session)", () => {
  const body = buildCalculationRequestBody("LNY01", baseState()) as unknown as Record<string, unknown>;
  assert.equal("shop" in body, false);
  assert.equal("shopDomain" in body, false);
});

// ============================================================================
// Task 4A.3 — shared "Selected Configuration" view model + inline quantity pricing
// ============================================================================

function optionValue(id: string, label: string): PricingCatalogOptionGroup["values"][number] {
  return { id, code: id.toUpperCase(), label, priceCode: null, priceAdjustmentCents: 0, resolvedPriceCents: 0, resolvedNetPriceCents: 0, priceSource: "option" };
}

function optionGroup(name: string, kind: string, values: PricingCatalogOptionGroup["values"]): PricingCatalogOptionGroup {
  return { name, kind, isRequired: false, categoryPriceAdjustmentCents: null, values };
}

function resultFixture(overrides: Partial<PricingCalculationResult> = {}): PricingCalculationResult {
  return {
    source: {
      storeId: "store-1",
      shopDomain: "imprintid-dev.myshopify.com",
      pricingProfileId: "profile-1",
      pricingProfileSku: "LNY01",
      resolvedVia: "sku",
    },
    quantity: 100,
    quantityTier: { id: "qt-1", minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 },
    availableQuantityTiers: [],
    base: { quantity: 100, listUnitPriceCents: 229, netUnitPriceCents: 137, listSubtotalCents: 22900, netSubtotalCents: 13700 },
    productColor: null,
    decoration: null,
    options: { selections: [], perUnitChargesCents: 0, netPerUnitChargesCents: 0, chargesCents: 0, netChargesCents: 0 },
    production: {
      code: "STANDARD",
      name: "Standard Production",
      isRush: false,
      minBusinessDays: 7,
      maxBusinessDays: 8,
      relatedSku: null,
      feeCents: null,
      notes: null,
    },
    packaging: null,
    totals: { listTotalCents: 22900, netTotalCents: 13700 },
    ...overrides,
  };
}

function rowValue(rows: Array<{ label: string; value: string }>, label: string): string | undefined {
  return rows.find((r) => r.label === label)?.value;
}

test("4A.3-1 formatListRateLabel: no price code -> 'List Price'; a code -> 'List Price (<code>)' (never fabricated)", () => {
  assert.equal(formatListRateLabel(null), "List Price");
  assert.equal(formatListRateLabel("6R"), "List Price (6R)");
  assert.equal(formatListRateLabel("A1"), "List Price (A1)");
});

test("4A.3-2 Quantity row carries the server-resolved unit price + rate label when a result is supplied", () => {
  const rows = buildSelectedConfigurationRows(buildCatalog(), baseState(), resultFixture());
  assert.equal(rowValue(rows, "Quantity"), "100 · List Price $2.29");
});

test("4A.3-3 Quantity row shows the tier's price code in parentheses, taken from the result (not hard-coded)", () => {
  const rows = buildSelectedConfigurationRows(
    buildCatalog(),
    baseState(),
    resultFixture({
      quantityTier: { id: "qt-1", minQuantity: 100, maxQuantity: 299, priceCode: "6R", listUnitPriceCents: 229, netUnitPriceCents: 137 },
    }),
  );
  assert.equal(rowValue(rows, "Quantity"), "100 · List Price (6R) $2.29");
});

test("4A.3-4 Quantity row without a result shows the quantity alone — no invented price", () => {
  const rows = buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), quantity: 250 });
  assert.equal(rowValue(rows, "Quantity"), "250");
});

test("4A.3-5 Quantity row is authoritative to the result (server quantity + price), never recomputed from state", () => {
  const rows = buildSelectedConfigurationRows(
    buildCatalog(),
    { ...baseState(), quantity: 999 },
    resultFixture({
      quantity: 100,
      base: { quantity: 100, listUnitPriceCents: 229, netUnitPriceCents: 137, listSubtotalCents: 22900, netSubtotalCents: 13700 },
    }),
  );
  assert.equal(rowValue(rows, "Quantity"), "100 · List Price $2.29");
});

test("4A.3-6 Product Color row uses the catalog's human-readable name and is omitted when unselected", () => {
  const catalog = buildCatalog({ productColors: [{ code: "NVY", name: "Navy Blue", priceCode: null, priceAdjustmentCents: 0 }] });
  assert.equal(rowValue(buildSelectedConfigurationRows(catalog, baseState()), "Product Color"), undefined);
  const rows = buildSelectedConfigurationRows(catalog, { ...baseState(), productColorCode: "NVY" });
  assert.equal(rowValue(rows, "Product Color"), "Navy Blue");
});

test("4A.3-7 Decoration Method row renders the friendly label, and only when a method is selected", () => {
  assert.equal(
    rowValue(buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), decorationMethod: null }), "Decoration Method"),
    undefined,
  );
  const rows = buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), decorationMethod: "SCREEN_PRINT" });
  assert.equal(rowValue(rows, "Decoration Method"), "Screen Print");
});

test("4A.3-8 Decoration Colors and Imprint Location rows reflect the selected counts", () => {
  const one = buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), colors: 1, locations: 1 });
  assert.equal(rowValue(one, "Decoration Colors"), "1 Color");
  assert.equal(rowValue(one, "Imprint Location"), "Front Only");
  const two = buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), colors: 2, locations: 2 });
  assert.equal(rowValue(two, "Decoration Colors"), "2+ Colors");
  assert.equal(rowValue(two, "Imprint Location"), "Front + Back");
});

test("4A.3-9 Reverse Side always shows Yes/No; Reverse Artwork appears only when reverse side is on", () => {
  const off = buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), reverseSide: false, differentReverseArtwork: true });
  assert.equal(rowValue(off, "Reverse Side"), "No");
  assert.equal(rowValue(off, "Reverse Artwork"), undefined);
  const same = buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), reverseSide: true, differentReverseArtwork: false });
  assert.equal(rowValue(same, "Reverse Side"), "Yes");
  assert.equal(rowValue(same, "Reverse Artwork"), "Same as front");
  const diff = buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), reverseSide: true, differentReverseArtwork: true });
  assert.equal(rowValue(diff, "Reverse Artwork"), "Different from front");
});

test("4A.3-10 Repeat Order row is always shown while decoration is selected, including the 'No' value", () => {
  assert.equal(rowValue(buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), repeatOrder: false }), "Repeat Order"), "No");
  assert.equal(rowValue(buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), repeatOrder: true }), "Repeat Order"), "Yes");
});

test("4A.3-11 no decoration-related rows appear when no decoration method is selected", () => {
  const rows = buildSelectedConfigurationRows(buildCatalog(), { ...baseState(), decorationMethod: null });
  for (const label of ["Decoration Method", "Decoration Colors", "Imprint Location", "Reverse Side", "Reverse Artwork", "Repeat Order"]) {
    assert.equal(rowValue(rows, label), undefined, `${label} must be absent`);
  }
});

test("4A.3-12 option groups render in catalog order, not selectedOptionValueIds insertion order", () => {
  const catalog = buildCatalog({
    optionGroups: [
      optionGroup("Alpha", "FEATURE", [optionValue("a1", "Alpha One")]),
      optionGroup("Bravo", "FEATURE", [optionValue("b1", "Bravo One")]),
    ],
  });
  const state = { ...baseState(), selectedOptionValueIds: { Bravo: "b1", Alpha: "a1" } };
  const labels = buildSelectedConfigurationRows(catalog, state).map((r) => r.label);
  assert.ok(labels.indexOf("Alpha") < labels.indexOf("Bravo"), "Alpha (catalog-first) must precede Bravo");
});

test("4A.3-13 only selected option groups produce a row, showing the value label (never its id/code)", () => {
  const catalog = buildCatalog({
    optionGroups: [
      optionGroup("Safety", "FEATURE", [optionValue("opt-break", "Safety Breakaway"), optionValue("opt-none", "None")]),
      optionGroup("Unused", "GENERIC", []),
    ],
  });
  const rows = buildSelectedConfigurationRows(catalog, { ...baseState(), selectedOptionValueIds: { Safety: "opt-break" } });
  assert.equal(rowValue(rows, "Safety"), "Safety Breakaway");
  assert.equal(rowValue(rows, "Unused"), undefined);
  assert.ok(!rows.some((r) => r.value === "opt-break" || r.value === "OPT-BREAK"));
});

test("4A.3-14 an unfamiliar option-group kind still appears; an unresolvable selection is skipped safely", () => {
  const catalog = buildCatalog({
    optionGroups: [optionGroup("Future Group", "PACKAGING_ADDON", [optionValue("f1", "Gift Box")])],
  });
  const ok = buildSelectedConfigurationRows(catalog, { ...baseState(), selectedOptionValueIds: { "Future Group": "f1" } });
  assert.equal(rowValue(ok, "Future Group"), "Gift Box");
  const bad = buildSelectedConfigurationRows(catalog, { ...baseState(), selectedOptionValueIds: { "Future Group": "nope" } });
  assert.equal(rowValue(bad, "Future Group"), undefined);
});

test("4A.3-15 Production uses the rule name (omitted when unset); Packaging comes from the result; buildQuoteSummary shares the builder", () => {
  const catalog = buildCatalog();
  assert.equal(rowValue(buildSelectedConfigurationRows(catalog, { ...baseState(), productionCode: null }), "Production"), undefined);
  assert.equal(rowValue(buildSelectedConfigurationRows(catalog, { ...baseState(), productionCode: "STANDARD" }), "Production"), "Standard");

  const withPackaging = resultFixture({
    packaging: { code: "BULK", name: "Bulk Carton", unitsPerPackage: null, cartonWeightLbs: null, lengthIn: null, widthIn: null, heightIn: null, feeCents: null },
  });
  assert.equal(rowValue(buildSelectedConfigurationRows(catalog, baseState()), "Packaging"), undefined);
  assert.equal(rowValue(buildSelectedConfigurationRows(catalog, baseState(), withPackaging), "Packaging"), "Bulk Carton");

  assert.deepEqual(buildQuoteSummary(catalog, baseState()), buildSelectedConfigurationRows(catalog, baseState()));
});

// ============================================================================
// Task 4A.3.1 — final Price Summary cleanup (unit price shown inline only)
// ============================================================================

const PRICING_SUMMARY_SOURCE = readFileSync(
  new URL("../../routes/app.product-configuration/components/PricingSummary.tsx", import.meta.url),
  "utf8",
);

test("4A.3.1-1 quantity and unit price stay inline in the first Selected Configuration row (rate label data-driven, no code)", () => {
  const rows = buildSelectedConfigurationRows(buildCatalog(), baseState(), resultFixture());
  assert.equal(rows[0]?.label, "Quantity");
  assert.equal(rows[0]?.value, "100 · List Price $2.29");
  assert.ok(!rows[0]?.value.includes("(6R)"), "no hard-coded price code when the tier supplies none");
});

test("4A.3.1-2 the rate code appears inline only when the authoritative quantity tier supplies priceCode", () => {
  const withCode = buildSelectedConfigurationRows(
    buildCatalog(),
    baseState(),
    resultFixture({
      quantityTier: { id: "qt-1", minQuantity: 100, maxQuantity: 299, priceCode: "6R", listUnitPriceCents: 229, netUnitPriceCents: 137 },
    }),
  );
  assert.equal(withCode[0]?.value, "100 · List Price (6R) $2.29");
});

test("4A.3.1-3 no separate 'Per unit' row is produced anywhere in the shared configuration rows", () => {
  const rows = buildSelectedConfigurationRows(buildCatalog(), baseState(), resultFixture());
  assert.ok(!rows.some((r) => /per unit/i.test(r.label)), "unit price is inline in Quantity, never its own row");
});

test("4A.3.1-4 PricingSummarySection renders no 'Per unit' breakdown line and no second use of the unit price", () => {
  assert.ok(!/Per unit/i.test(PRICING_SUMMARY_SOURCE), "the 'Per unit (list)' breakdown row must be gone");
  assert.ok(
    !PRICING_SUMMARY_SOURCE.includes("base.listUnitPriceCents"),
    "the breakdown must not re-render the unit price (it is inline in the Selected Configuration row)",
  );
});

test("4A.3.1-5 the preserved Pricing Breakdown rows and both totals are still rendered from the authoritative result", () => {
  for (const token of [
    "Base subtotal",
    "result.base.listSubtotalCents",
    "Product color",
    "result.productColor.priceAdjustmentCents",
    "Decoration",
    "result.decoration.listChargesCents",
    "Options",
    "result.options.chargesCents",
    "Production",
    "result.production.feeCents",
    "Packaging",
    "result.packaging.feeCents",
    "Estimated Total (List)",
    "result.totals.listTotalCents",
    "Net Total",
    "result.totals.netTotalCents",
  ]) {
    assert.ok(PRICING_SUMMARY_SOURCE.includes(token), `Pricing Breakdown must still reference: ${token}`);
  }
});

test("4A.3.1-6 this presentation change cannot trigger recalculation: the fingerprint ignores the priced result entirely", () => {
  const state = baseState();
  const noResult = buildCalculationFingerprint("LNY01", state);
  // Building the display rows (with or without a result) is pure and never feeds the fingerprint.
  buildSelectedConfigurationRows(buildCatalog(), state, resultFixture());
  buildSelectedConfigurationRows(buildCatalog(), state, null);
  assert.equal(buildCalculationFingerprint("LNY01", state), noResult, "fingerprint is unchanged by row rendering");
  assert.deepEqual(state, baseState(), "buildSelectedConfigurationRows never mutates the configuration state");
});
