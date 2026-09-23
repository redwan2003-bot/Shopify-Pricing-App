import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCartPricingPayload,
  canonicalizeCartPricingPayload,
  signCartPricingPayload,
} from "./cart-signature.ts";
import { signHex, timingSafeEqualHex } from "./hmac-sha256.ts";
import type { PricingCalculationResult } from "../pricing/index.ts";

function buildResult(overrides: Partial<PricingCalculationResult> = {}): PricingCalculationResult {
  return {
    source: { storeId: "store1", shopDomain: "shop.myshopify.com", pricingProfileId: "profile1", pricingProfileSku: "LNY01", resolvedVia: "sku" },
    quantity: 1000,
    quantityTier: { id: "t1", minQuantity: 1000, maxQuantity: 2999, priceCode: null, listUnitPriceCents: 164, netUnitPriceCents: 98 },
    availableQuantityTiers: [],
    base: { quantity: 1000, listUnitPriceCents: 164, netUnitPriceCents: 98, listSubtotalCents: 164000, netSubtotalCents: 98000 },
    productColor: null,
    decoration: {
      method: "SCREEN_PRINT",
      charges: [
        { code: "SETUP_1C1L", name: "Setup", chargeBasis: "ONE_TIME", occurrences: 1, listPriceCents: 4500, netPriceCents: 3600, listLineTotalCents: 4500, netLineTotalCents: 3600 },
        { code: "COLOR_2_SETUP", name: "Color 2 Setup", chargeBasis: "ONE_TIME", occurrences: 1, listPriceCents: 3500, netPriceCents: 2800, listLineTotalCents: 3500, netLineTotalCents: 2800 },
        { code: "COLOR_2_RUN", name: "Color 2 Run", chargeBasis: "PER_UNIT", occurrences: 1000, listPriceCents: 25, netPriceCents: 20, listLineTotalCents: 25000, netLineTotalCents: 20000 },
      ],
      listChargesCents: 33000,
      netChargesCents: 26400,
    },
    options: { selections: [], perUnitChargesCents: 0, netPerUnitChargesCents: 0, chargesCents: 0, netChargesCents: 0 },
    production: { code: "RUSH", name: "Rush", isRush: true, minBusinessDays: 5, maxBusinessDays: 5, relatedSku: null, feeCents: null, notes: null },
    packaging: null,
    totals: { listTotalCents: 197000, netTotalCents: 124400 },
    ...overrides,
  };
}

test("buildCartPricingPayload decomposition sums exactly back to totals.netTotalCents", () => {
  const result = buildResult();
  const payload = buildCartPricingPayload(result, "USD", "gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2", 1000);

  const reconstructed =
    payload.baseUnitPriceCents * payload.quantity +
    payload.perUnitSurchargeCents * payload.quantity +
    payload.flatSurchargeCents;

  assert.equal(reconstructed, result.totals.netTotalCents);
  assert.equal(payload.perUnitSurchargeCents, 20); // COLOR_2_RUN rate only
  assert.equal(payload.flatSurchargeCents, 3600 + 2800); // SETUP_1C1L + COLOR_2_SETUP, no production/packaging/options here
});

test("buildCartPricingPayload puts option surcharges per piece and production/packaging/color in the flat component", () => {
  const result = buildResult({
    decoration: null,
    productColor: { code: "ROYAL", name: "Royal Blue", priceCode: null, priceAdjustmentCents: 15 },
    options: {
      selections: [{ groupName: "Optional Features", optionValueId: "ov1", optionLabel: "Cell Phone Loop", source: "option", priceAdjustmentCents: 25, netPriceAdjustmentCents: 25 }],
      perUnitChargesCents: 25,
      netPerUnitChargesCents: 25,
      chargesCents: 25 * 1000,
      netChargesCents: 25 * 1000,
    },
    production: { code: "RUSH", name: "Rush", isRush: true, minBusinessDays: 5, maxBusinessDays: 5, relatedSku: null, feeCents: 500, notes: null },
    packaging: { code: "STANDARD_CARTON", name: "Standard Carton", unitsPerPackage: 250, cartonWeightLbs: 8.5, lengthIn: 12, widthIn: 8, heightIn: 6, feeCents: 100 },
    totals: { listTotalCents: 164000, netTotalCents: 98000 + 15 + 25 * 1000 + 500 + 100 },
  });
  const payload = buildCartPricingPayload(result, "USD", "gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2", 1000);

  assert.equal(payload.perUnitSurchargeCents, 25, "the option is charged for every piece");
  assert.equal(payload.flatSurchargeCents, 15 + 500 + 100, "color, production and packaging stay one-time");
  assert.equal(
    payload.baseUnitPriceCents * payload.quantity + payload.perUnitSurchargeCents * payload.quantity + payload.flatSurchargeCents,
    result.totals.netTotalCents,
  );
});

test("the signed quote charges options at their NET price per piece, matching the displayed net total", () => {
  // Heavy Duty attachment: list 31c / net 23c per piece. A signed quote at the list price would
  // charge more than the customer was shown.
  const result = buildResult({
    decoration: null,
    options: {
      selections: [{ groupName: "Heavy Duty Attachment", optionValueId: "ov2", optionLabel: "Oval Hook", source: "option", priceAdjustmentCents: 31, netPriceAdjustmentCents: 23 }],
      perUnitChargesCents: 31,
      netPerUnitChargesCents: 23,
      chargesCents: 31 * 1000,
      netChargesCents: 23 * 1000,
    },
    totals: { listTotalCents: 164000 + 31 * 1000, netTotalCents: 98000 + 23 * 1000 },
  });
  const v1 = buildCartPricingPayload(result, "USD", "gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2", 1000);
  assert.equal(v1.perUnitSurchargeCents, 23);
  assert.equal(v1.baseUnitPriceCents * v1.quantity + v1.perUnitSurchargeCents * v1.quantity + v1.flatSurchargeCents, result.totals.netTotalCents);
});

test("buildCartPricingPayload sets expiresAt 30 minutes from the given `now`", () => {
  const result = buildResult();
  const payload = buildCartPricingPayload(result, "USD", "v1", "v2", 1_000_000);
  assert.equal(payload.expiresAt, 1_000_000 + 30 * 60);
});

test("canonicalizeCartPricingPayload produces a stable, sorted-key representation", () => {
  const a = { v: 1 as const, sku: "LNY01", quantity: 1000, currency: "USD", baseVariantId: "v1", baseUnitPriceCents: 98, perUnitSurchargeCents: 20, flatSurchargeCents: 6400, adjustmentVariantId: "v2", expiresAt: 123 };
  const canonical = canonicalizeCartPricingPayload(a);
  // keys sorted alphabetically
  const keysInOrder = canonical.split("\n").map((line) => line.split("=")[0]);
  assert.deepEqual(keysInOrder, [...keysInOrder].sort());
  assert.ok(canonical.includes("sku=LNY01"));
  assert.ok(canonical.includes("quantity=1000"));
});

test("signCartPricingPayload's signature matches signing the canonical string directly", () => {
  const result = buildResult();
  const payload = buildCartPricingPayload(result, "USD", "v1", "v2", 1000);
  const signed = signCartPricingPayload(payload, "test-secret");

  const expectedSignature = signHex("test-secret", canonicalizeCartPricingPayload(payload));
  assert.ok(timingSafeEqualHex(signed.signature, expectedSignature));

  // `payload` field round-trips to the exact same object via JSON
  assert.deepEqual(JSON.parse(signed.payload), payload);
});

test("signCartPricingPayload produces a different signature for a different secret", () => {
  const result = buildResult();
  const payload = buildCartPricingPayload(result, "USD", "v1", "v2", 1000);
  const a = signCartPricingPayload(payload, "secret-a");
  const b = signCartPricingPayload(payload, "secret-b");
  assert.notEqual(a.signature, b.signature);
});

test("signCartPricingPayload produces a different signature if any field of the payload changes", () => {
  const result = buildResult();
  const payload = buildCartPricingPayload(result, "USD", "v1", "v2", 1000);
  const tampered = { ...payload, quantity: payload.quantity + 1 };
  const original = signCartPricingPayload(payload, "secret");
  const tamperedSigned = signCartPricingPayload(tampered, "secret");
  assert.notEqual(original.signature, tamperedSigned.signature);
});
