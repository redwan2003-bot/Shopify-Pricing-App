import { test } from "node:test";
import assert from "node:assert/strict";
import { DecorationMethod, DecorationChargeBasis } from "@prisma/client";
import { validatePricingProfileImport } from "./validate.ts";
import { buildLny01PricingInput } from "../../../prisma/seed-data/lny01.ts";
import type { PricingProfileImportInput } from "./types.ts";

function validLny01Input(): PricingProfileImportInput {
  return buildLny01PricingInput("test-shop.myshopify.com");
}

test("accepts the real LNY01 pricing package", () => {
  const result = validatePricingProfileImport(validLny01Input());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("rejects a negative quantity", () => {
  const input = validLny01Input();
  input.quantityTiers[0]!.minQuantity = -100;
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "quantityTiers[0].minQuantity"));
});

test("rejects a zero quantity", () => {
  const input = validLny01Input();
  input.quantityTiers[0]!.minQuantity = 0;
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
});

test("rejects duplicate quantity tiers", () => {
  const input = validLny01Input();
  input.quantityTiers.push({ ...input.quantityTiers[0]! });
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.message.includes("duplicate quantity tier")),
  );
});

test("rejects a negative price", () => {
  const input = validLny01Input();
  input.quantityTiers[0]!.netPriceCents = -137;
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "quantityTiers[0].netPriceCents"));
});

test("rejects a non-integer (floating point) price", () => {
  const input = validLny01Input();
  input.quantityTiers[0]!.listPriceCents = 2.29;
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.path === "quantityTiers[0].listPriceCents" && e.message.includes("integer"),
    ),
  );
});

test("net price may not exceed list price", () => {
  const input = validLny01Input();
  input.quantityTiers[0]!.netPriceCents = 300;
  input.quantityTiers[0]!.listPriceCents = 229;
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
});

test("treats a missing option price as valid (null = not supplied)", () => {
  const input = validLny01Input();
  input.optionGroups[0]!.values[0]!.priceAdjustmentCents = undefined;
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, true);
});

test("rejects an invalid decoration charge basis", () => {
  const input = validLny01Input();
  // @ts-expect-error deliberately invalid for the test
  input.decorationRules[0]!.chargeBasis = "SOMETIMES";
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "decorationRules[0].chargeBasis"));
});

test("rejects duplicate decoration rule codes", () => {
  const input = validLny01Input();
  input.decorationRules.push({
    code: input.decorationRules[0]!.code,
    name: "Duplicate",
    method: DecorationMethod.SCREEN_PRINT,
    chargeBasis: DecorationChargeBasis.ONE_TIME,
    listPriceCents: 100,
    netPriceCents: 80,
  });
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.message.includes("duplicate decoration rule code")));
});

test("rejects a missing SKU", () => {
  const input = validLny01Input();
  input.sku = "";
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "sku"));
});

test("rejects production rule with maxBusinessDays below minBusinessDays", () => {
  const input = validLny01Input();
  input.productionRules[0]!.minBusinessDays = 8;
  input.productionRules[0]!.maxBusinessDays = 7;
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
});

test("rejects non-positive packaging dimensions", () => {
  const input = validLny01Input();
  input.packagingRules[0]!.cartonWeightLbs = 0;
  const result = validatePricingProfileImport(input);
  assert.equal(result.valid, false);
});
