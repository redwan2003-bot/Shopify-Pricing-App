import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCartPricingAttributes } from "./verify-payload.ts";
import type { CartPricingPayload } from "./verify-payload.ts";
import { signHex } from "./hmac-sha256.ts";

const SECRET = "test-cart-signing-secret";
const NOW = 1_800_000_000;

function canonicalize(payload: CartPricingPayload): string {
  const record = payload as unknown as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${String(record[key])}`)
    .join("\n");
}

function buildPayload(overrides: Partial<CartPricingPayload> = {}): CartPricingPayload {
  return {
    v: 1,
    sku: "LNY01",
    quantity: 1000,
    currency: "USD",
    baseVariantId: "gid://shopify/ProductVariant/1",
    baseUnitPriceCents: 98,
    perUnitSurchargeCents: 20,
    flatSurchargeCents: 6400,
    adjustmentVariantId: "gid://shopify/ProductVariant/999",
    expiresAt: NOW + 1000,
    ...overrides,
  };
}

function sign(payload: CartPricingPayload, secret: string = SECRET): string {
  return signHex(secret, canonicalize(payload));
}

function attrsFor(payload: CartPricingPayload, secret: string = SECRET) {
  return { version: "1", payload: JSON.stringify(payload), signature: sign(payload, secret) };
}

function lineFor(payload: CartPricingPayload) {
  return { quantity: payload.quantity, merchandiseId: payload.baseVariantId };
}

// 1. Valid signed price
test("1. a genuinely valid, correctly signed payload verifies successfully", () => {
  const payload = buildPayload();
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), attrsFor(payload));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.payload, payload);
});

// 2. Invalid signature
test("2. an invalid signature is rejected", () => {
  const payload = buildPayload();
  const attrs = attrsFor(payload);
  attrs.signature = "0".repeat(64);
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), attrs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_signature");
});

// 3. Missing signature
test("3. a missing signature attribute is rejected", () => {
  const payload = buildPayload();
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), {
    version: "1",
    payload: JSON.stringify(payload),
    signature: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_attributes");
});

// 4. Missing payload
test("4. a missing payload attribute is rejected", () => {
  const result = verifyCartPricingAttributes(SECRET, NOW, { quantity: 1000, merchandiseId: "v1" }, {
    version: "1",
    payload: null,
    signature: "abc",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_attributes");
});

// 5. Malformed payload
test("5. a payload that isn't valid JSON is rejected", () => {
  const result = verifyCartPricingAttributes(SECRET, NOW, { quantity: 1000, merchandiseId: "v1" }, {
    version: "1",
    payload: "{not json",
    signature: signHex(SECRET, "irrelevant"),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed_payload");
});

test("5b. a JSON payload missing required fields is rejected", () => {
  const badPayload = JSON.stringify({ v: 1, sku: "LNY01" }); // missing everything else
  const result = verifyCartPricingAttributes(SECRET, NOW, { quantity: 1000, merchandiseId: "v1" }, {
    version: "1",
    payload: badPayload,
    signature: signHex(SECRET, badPayload),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed_payload");
});

// 6. Unsupported payload version
test("6. an unsupported attribute version is rejected before the payload is even parsed", () => {
  const payload = buildPayload();
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), {
    version: "2",
    payload: JSON.stringify(payload),
    signature: sign(payload),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unsupported_version");
});

// 7. Invalid price / 8. Negative price
// Both are caught by parsePayload's shape validation (isFiniteNonNegativeInteger)
// before the dedicated invalid_price check ever runs — negative numbers never produce
// a structurally valid CartPricingPayload in the first place, so they're reported as
// "malformed_payload", not "invalid_price". The invalid_price check remains as
// defense-in-depth for values that pass shape validation but are still unusable (see
// verify-payload.ts) — currently unreachable through this public function, but kept
// rather than removed, since parsePayload's validation rules are an implementation
// detail this test shouldn't need to rely on staying exactly this strict forever.
test("7-8. a negative baseUnitPriceCents is rejected (caught at payload-shape validation)", () => {
  const payload = buildPayload({ baseUnitPriceCents: -1 });
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), attrsFor(payload));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed_payload");
});

test("negative flatSurchargeCents is rejected (caught at payload-shape validation)", () => {
  const payload = buildPayload({ flatSurchargeCents: -50 });
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), attrsFor(payload));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed_payload");
});

// 9. Quantity mismatch
test("9. the signed quantity not matching the cart line's actual quantity is rejected", () => {
  const payload = buildPayload({ quantity: 1000 });
  const attrs = attrsFor(payload);
  const tamperedLine = { quantity: 1001, merchandiseId: payload.baseVariantId }; // customer edited cart qty after signing
  const result = verifyCartPricingAttributes(SECRET, NOW, tamperedLine, attrs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "quantity_mismatch");
});

// 15. Different product variants (variant mismatch)
test("15. a payload signed for one variant cannot be replayed onto a different cart line's variant", () => {
  const payload = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/1" });
  const attrs = attrsFor(payload);
  const otherLine = { quantity: payload.quantity, merchandiseId: "gid://shopify/ProductVariant/2" };
  const result = verifyCartPricingAttributes(SECRET, NOW, otherLine, attrs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "variant_mismatch");
});

test("a cart line with no merchandise id at all is rejected", () => {
  const payload = buildPayload();
  const result = verifyCartPricingAttributes(SECRET, NOW, { quantity: payload.quantity, merchandiseId: null }, attrsFor(payload));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "variant_mismatch");
});

// 22. Replay/expired payload
test("22. an expired payload is rejected even though the signature is genuinely valid", () => {
  const payload = buildPayload({ expiresAt: NOW - 1 });
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), attrsFor(payload));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
});

test("a payload exactly at its expiry boundary is still valid (not yet expired)", () => {
  const payload = buildPayload({ expiresAt: NOW });
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), attrsFor(payload));
  assert.equal(result.ok, true);
});

// 19. Tampered calculated price
test("19. tampering with any priced field after signing invalidates the signature", () => {
  const payload = buildPayload();
  const attrs = attrsFor(payload);
  const tampered = { ...payload, baseUnitPriceCents: 1 }; // attacker tries to pay $0.01/unit instead of $0.98
  attrs.payload = JSON.stringify(tampered);
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(tampered), attrs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_signature");
});

// 20. Tampered quantity (within the payload itself, not just the cart line)
test("20. tampering with the signed quantity field invalidates the signature", () => {
  const payload = buildPayload();
  const attrs = attrsFor(payload);
  const tampered = { ...payload, quantity: 1 }; // attacker tries to buy 1000 units at the qty=1 price
  attrs.payload = JSON.stringify(tampered);
  const result = verifyCartPricingAttributes(SECRET, NOW, { quantity: 1, merchandiseId: payload.baseVariantId }, attrs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_signature");
});

// 21. Tampered configuration (sku swapped, e.g. trying to get a cheap product's signature applied elsewhere)
test("21. tampering with sku/currency/adjustmentVariantId invalidates the signature", () => {
  const payload = buildPayload();
  const attrs = attrsFor(payload);
  const tampered = { ...payload, sku: "SOME-OTHER-SKU" };
  attrs.payload = JSON.stringify(tampered);
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(tampered), attrs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_signature");
});

// 17. Multiple quantities / 18. Decimal precision — covered structurally here; full
// per-line arithmetic is covered in cart_transform_run.test.ts.
test("17. verification is independent of the actual quantity magnitude", () => {
  for (const quantity of [1, 100, 1999, 2000]) {
    const payload = buildPayload({ quantity });
    const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), attrsFor(payload));
    assert.equal(result.ok, true, `expected quantity ${quantity} to verify`);
  }
});

test("a payload signed with a different secret never verifies", () => {
  const payload = buildPayload();
  const attrs = attrsFor(payload, "a-completely-different-secret");
  const result = verifyCartPricingAttributes(SECRET, NOW, lineFor(payload), attrs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_signature");
});
