import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultConfigurationState,
  buildCalculationRequestBody,
  selectAttachmentGroups,
  selectFeatureGroups,
  selectGenericGroups,
} from "./view-model.ts";
import type { PricingCatalog } from "../pricing-api/catalog.ts";
import type { ProductConfigurationState } from "./types.ts";

function buildCatalog(overrides: Partial<PricingCatalog> = {}): PricingCatalog {
  return {
    sku: "LNY01",
    quantityTiers: [
      { minQuantity: 1000, maxQuantity: 2999, priceCode: null, listUnitPriceCents: 164, netUnitPriceCents: 98 },
      { minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 },
    ],
    productColors: [],
    decorationMethods: ["SCREEN_PRINT"],
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
