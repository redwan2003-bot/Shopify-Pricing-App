import { test } from "node:test";
import assert from "node:assert/strict";
import { blankDraft, draftToImportInput, formatMoney, parseMoney, profileToDraft, type StoredProfile } from "./draft.ts";
import { validatePricingProfileImport } from "../pricing-import/validate.ts";

const stored: StoredProfile = {
  sku: "LNY01",
  name: '1" Nylon Lanyards (LNY01)',
  description: null,
  currency: "USD",
  quantityTiers: [
    { minQuantity: 300, maxQuantity: 499, listPriceCents: 212, netPriceCents: 127 },
    { minQuantity: 100, maxQuantity: 299, listPriceCents: 229, netPriceCents: 137 },
  ],
  decorationRules: [
    { method: "SCREEN_PRINT", code: "SETUP_1C1L", name: "Setup", listPriceCents: 4500, netPriceCents: 3600 },
    { method: "SCREEN_PRINT", code: "REPEAT_ORDER_SETUP", name: "Repeat", listPriceCents: 2500, netPriceCents: 2000 },
  ],
  decorationColorCharges: [{ method: "SCREEN_PRINT", colorNumber: 2, chargeBasis: "PER_UNIT", listPriceCents: 25, netPriceCents: 20, isActive: true }],
  optionGroups: [
    {
      name: "Heavy Duty Attachment",
      kind: "ATTACHMENT",
      isRequired: false,
      sortOrder: 0,
      optionValues: [
        { label: "Oval Hook", code: "oval", priceAdjustmentCents: 31, netPriceAdjustmentCents: 23, isDefault: false, sortOrder: 0 },
        { label: "Unpriced", code: null, priceAdjustmentCents: null, netPriceAdjustmentCents: null, isDefault: false, sortOrder: 1 },
      ],
    },
  ],
  productionRules: [{ code: "STANDARD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, feeCents: 0, notes: null }],
};
const passthrough = { packagingRules: [{ code: "CARTON", name: "Carton", unitsPerPackage: 100 }], productColors: [] };

test("money parses exactly, never through floating point", () => {
  assert.deepEqual(parseMoney("1.37"), { ok: true, cents: 137 });
  assert.deepEqual(parseMoney("$1.3"), { ok: true, cents: 130 });
  assert.deepEqual(parseMoney("0.29"), { ok: true, cents: 29 }, "0.29 * 100 is 28.999... in floating point");
  assert.deepEqual(parseMoney("1,234.50"), { ok: true, cents: 123450 });
  assert.deepEqual(parseMoney("  "), { ok: true, cents: null });
  for (const bad of ["1.234", "-1", "abc", "1.2.3", "1e3"]) assert.equal(parseMoney(bad).ok, false, bad);
  assert.equal(formatMoney(5), "0.05");
  assert.equal(formatMoney(null), "");
});

test("a stored profile round-trips through the editor unchanged", () => {
  const draft = profileToDraft(stored);
  assert.deepEqual(draft.tiers.map((t) => t.min), ["100", "300"], "tiers sorted ascending");
  const r = draftToImportInput(draft, "s.myshopify.com", passthrough);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors));
  if (!r.ok) return;
  assert.deepEqual(
    r.input.quantityTiers.map((t) => [t.minQuantity, t.maxQuantity, t.listPriceCents, t.netPriceCents]),
    [[100, 299, 229, 137], [300, 499, 212, 127]],
  );
  assert.deepEqual(r.input.decorationRules.map((d) => [d.code, d.chargeBasis, d.listPriceCents, d.netPriceCents]), [
    ["SETUP_1C1L", "ONE_TIME", 4500, 3600],
    ["REPEAT_ORDER_SETUP", "ONE_TIME", 2500, 2000],
  ]);
  assert.deepEqual(r.input.decorationColorCharges, [{ method: "SCREEN_PRINT", colorNumber: 2, chargeBasis: "PER_UNIT", listPriceCents: 25, netPriceCents: 20 }]);
  const values = r.input.optionGroups[0]!.values;
  assert.deepEqual([values[0]!.priceAdjustmentCents, values[0]!.netPriceAdjustmentCents], [31, 23]);
  assert.deepEqual([values[1]!.priceAdjustmentCents, values[1]!.netPriceAdjustmentCents], [null, null], "blank stays 'not supplied', not $0");
  assert.deepEqual(r.input.packagingRules, passthrough.packagingRules, "packaging passed through untouched");
  assert.equal(validatePricingProfileImport(r.input).valid, true, "the importer accepts it");
});

test("bad input is reported per field instead of being saved", () => {
  const draft = profileToDraft(stored);
  draft.tiers[0]!.list = "2.2.9";
  draft.tiers[1]!.net = "";
  draft.decorations[0]!.slots.SETUP_1C1L = { name: "", list: "", net: "" };
  draft.optionGroups[0]!.values[0]!.label = "";
  draft.production[0]!.isRush = true;
  const r = draftToImportInput(draft, "s.myshopify.com", passthrough);
  assert.equal(r.ok, false);
  const fields = !r.ok ? r.errors.map((e) => e.field) : [];
  for (const f of ["tiers.0.list", "tiers.1.net", "decorations.0.SETUP_1C1L", "optionGroups.0.values.0.label", "production"]) {
    assert.ok(fields.includes(f), `expected an error on ${f}, got ${fields.join(", ")}`);
  }
});

test("a new blank profile needs a SKU, name and prices, then imports with a default carton", () => {
  const draft = blankDraft("USD");
  const empty = draftToImportInput(draft, "s.myshopify.com", { packagingRules: [], productColors: [] });
  assert.equal(empty.ok, false);
  draft.sku = "NEW01";
  draft.name = "New lanyard";
  draft.tiers[0] = { min: "50", max: "", list: "3.00", net: "1.80" };
  const r = draftToImportInput(draft, "s.myshopify.com", { packagingRules: [], productColors: [] });
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.errors));
  if (r.ok) {
    assert.deepEqual(r.input.packagingRules, [{ code: "STANDARD_CARTON", name: "Standard carton" }]);
    assert.equal(validatePricingProfileImport(r.input).valid, true);
  }
  draft.sku = "has spaces";
  assert.equal(draftToImportInput(draft, "s.myshopify.com", { packagingRules: [], productColors: [] }).ok, false);
});

test("net above list is caught by the importer's own validation", () => {
  const draft = profileToDraft(stored);
  draft.tiers[0]!.net = "9.99";
  const r = draftToImportInput(draft, "s.myshopify.com", passthrough);
  assert.ok(r.ok);
  if (r.ok) assert.equal(validatePricingProfileImport(r.input).valid, false);
});
