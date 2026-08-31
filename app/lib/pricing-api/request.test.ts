import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePricingRequestBody } from "./request.ts";

const validBody = {
  sku: "LNY01",
  quantity: 1000,
  productColor: { code: "BLACK" },
  decoration: {
    method: "SCREEN_PRINT",
    colors: 2,
    locations: 1,
    reverseSide: false,
    differentReverseArtwork: false,
    repeatOrder: false,
  },
  options: [{ groupName: "Optional Features", optionValueId: "abc123" }],
  production: { code: "RUSH" },
  packaging: { code: "STANDARD_CARTON" },
};

test("accepts a fully-populated, correctly-shaped request", () => {
  const result = parsePricingRequestBody(validBody);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.input.sku, "LNY01");
    assert.equal(result.input.quantity, 1000);
    assert.equal(result.input.decoration?.colors, 2);
    assert.equal(result.input.options?.[0]!.groupName, "Optional Features");
    assert.equal(result.input.production?.code, "RUSH");
    // Phase 2.7 — this is a regression test for a real bug caught by
    // scripts/verify-app-proxy.mjs: productColor was silently dropped here before
    // ever reaching the engine.
    assert.equal(result.input.productColor?.code, "BLACK");
  }
});

test("accepts a minimal request with only sku and quantity", () => {
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: 100 });
  assert.equal(result.ok, true);
});

test("rejects a non-object body", () => {
  const result = parsePricingRequestBody("not an object");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issues[0]!.path, "(body)");
  }
});

test("rejects a missing sku", () => {
  const result = parsePricingRequestBody({ quantity: 100 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "sku"));
  }
});

test("rejects an empty-string sku", () => {
  const result = parsePricingRequestBody({ sku: "", quantity: 100 });
  assert.equal(result.ok, false);
});

test("rejects a missing quantity", () => {
  const result = parsePricingRequestBody({ sku: "LNY01" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "quantity"));
  }
});

test("rejects a quantity supplied as a string", () => {
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: "1000" });
  assert.equal(result.ok, false);
});

test("rejects a malformed decoration object (wrong types)", () => {
  const result = parsePricingRequestBody({
    sku: "LNY01",
    quantity: 100,
    decoration: { method: "SCREEN_PRINT", colors: "two", locations: 1, reverseSide: false, differentReverseArtwork: false, repeatOrder: false },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "decoration.colors"));
  }
});

test("rejects a decoration method not in the known enum", () => {
  const result = parsePricingRequestBody({
    sku: "LNY01",
    quantity: 100,
    decoration: { method: "LASER_ENGRAVE", colors: 1, locations: 1, reverseSide: false, differentReverseArtwork: false, repeatOrder: false },
  });
  assert.equal(result.ok, false);
});

test("rejects an incomplete decoration object (missing fields)", () => {
  const result = parsePricingRequestBody({
    sku: "LNY01",
    quantity: 100,
    decoration: { method: "SCREEN_PRINT", colors: 1 },
  });
  assert.equal(result.ok, false);
});

test("rejects a malformed option selection (missing optionValueId)", () => {
  const result = parsePricingRequestBody({
    sku: "LNY01",
    quantity: 100,
    options: [{ groupName: "Optional Features" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "options[0].optionValueId"));
  }
});

test("rejects options that isn't an array", () => {
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: 100, options: "not-an-array" });
  assert.equal(result.ok, false);
});

test("rejects a bare-string production selection (must be an object)", () => {
  // The spec's illustrative example used `"production": "RUSH"` — the real
  // CalculationInput type requires an object. This is exactly what should be rejected.
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: 100, production: "RUSH" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "production"));
  }
});

test("rejects a malformed packaging selection", () => {
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: 100, packaging: { code: 12345 } });
  assert.equal(result.ok, false);
});

test("rejects a productColor with a missing code", () => {
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: 100, productColor: {} });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "productColor.code"));
  }
});

test("rejects a bare-string productColor (must be an object)", () => {
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: 100, productColor: "BLACK" });
  assert.equal(result.ok, false);
});

test("accepts a request with no productColor at all (color is optional)", () => {
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: 100 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.input.productColor, undefined);
});

test("rejects a non-string shopifyProductId", () => {
  const result = parsePricingRequestBody({ sku: "LNY01", quantity: 100, shopifyProductId: 12345 });
  assert.equal(result.ok, false);
});

test("collects multiple issues in one response rather than stopping at the first", () => {
  const result = parsePricingRequestBody({ quantity: "not-a-number" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.length >= 2);
  }
});
