import { test } from "node:test";
import assert from "node:assert/strict";
import { runCartTransform, centsToDecimalString } from "./cart_transform_run.ts";
import type { CartPricingPayload } from "./verify-payload.ts";
import { signHex } from "./hmac-sha256.ts";
import type { CartTransformRunInput } from "../generated/api.ts";

const SECRET = "test-secret";
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

function attributeLine(
  id: string,
  merchandiseId: string | null,
  quantity: number,
  attrs: { version?: string | null; payload?: string | null; signature?: string | null } = {},
): CartTransformRunInput["cart"]["lines"][number] {
  return {
    id,
    quantity,
    merchandise: merchandiseId ? { id: merchandiseId } : {},
    version: attrs.version === undefined ? null : attrs.version === null ? null : { value: attrs.version },
    payload: attrs.payload === undefined ? null : attrs.payload === null ? null : { value: attrs.payload },
    signature: attrs.signature === undefined ? null : attrs.signature === null ? null : { value: attrs.signature },
  };
}

function signedLine(id: string, payload: CartPricingPayload, secret: string = SECRET): CartTransformRunInput["cart"]["lines"][number] {
  return attributeLine(id, payload.baseVariantId, payload.quantity, {
    version: "1",
    payload: JSON.stringify(payload),
    signature: signHex(secret, canonicalize(payload)),
  });
}

function input(lines: CartTransformRunInput["cart"]["lines"], presentmentCurrencyRate = "1"): CartTransformRunInput {
  return { cart: { lines }, presentmentCurrencyRate };
}

test("centsToDecimalString formats integer cents as exact Decimal strings at rate 1 (default)", () => {
  assert.equal(centsToDecimalString(98), "0.98");
  assert.equal(centsToDecimalString(100), "1.00");
  assert.equal(centsToDecimalString(6400), "64.00");
  assert.equal(centsToDecimalString(5), "0.05");
  assert.equal(centsToDecimalString(123456), "1234.56");
  assert.equal(centsToDecimalString(0), "0.00");
});

test("centsToDecimalString is exact when the rate is explicitly \"1\" or \"1.0\"", () => {
  assert.equal(centsToDecimalString(98, "1"), "0.98");
  assert.equal(centsToDecimalString(98, "1.0"), "0.98");
});

// Presentment currency: the schema documents ExpandedItem price amounts as being in
// presentment currency, not shop currency — this proves the conversion is actually
// applied, using Shopify's own documented `parseFloat(amount) * rate` pattern.
test("centsToDecimalString converts using a non-1 presentment currency rate", () => {
  // $0.98 shop currency at a 1.08 rate (e.g. USD shop, EUR-ish presentment) -> $1.06 (rounded)
  assert.equal(centsToDecimalString(98, "1.08"), (0.98 * 1.08).toFixed(2));
  assert.equal(centsToDecimalString(10000, "0.85"), (100 * 0.85).toFixed(2));
});

test("centsToDecimalString falls back to the exact shop-currency amount for a malformed rate, rather than crashing or guessing", () => {
  assert.equal(centsToDecimalString(500, "not-a-number"), "5.00");
  assert.equal(centsToDecimalString(500, "0"), "5.00");
  assert.equal(centsToDecimalString(500, "-1"), "5.00");
});

test("a non-1 presentment currency rate is applied end-to-end through runCartTransform", () => {
  const payload = buildPayload({ baseUnitPriceCents: 100, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1.10"), SECRET, NOW);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    assert.equal(op.lineExpand.expandedCartItems[0]!.price!.adjustment.fixedPricePerUnit.amount, "1.10");
  }
});

test("a presentment currency rate of \"1\" leaves single-currency carts byte-identical to before this fix", () => {
  const payload = buildPayload();
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1"), SECRET, NOW);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    const amounts = op.lineExpand.expandedCartItems.map((i) => i.price!.adjustment.fixedPricePerUnit.amount);
    assert.deepEqual(amounts, ["0.98", "0.20", "64.00"]);
  }
});

// 13. Empty cart
test("13. an empty cart produces zero operations", () => {
  const result = runCartTransform(input([]), SECRET, NOW);
  assert.deepEqual(result.operations, []);
});

// 12. Normal non-ImprintID cart line
test("12. a normal cart line with no ImprintID attributes at all is left untouched", () => {
  const result = runCartTransform(input([attributeLine("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/5", 2)]), SECRET, NOW);
  assert.deepEqual(result.operations, []);
});

// 14. Existing cart line attributes without ImprintID data (some other app's attribute present)
test("14. a line carrying unrelated attributes (not ImprintID's) is left untouched, not mistaken for one", () => {
  // Only the three specific keys this function's own GraphQL query requests are ever
  // visible to it — an unrelated attribute like "gift_wrapping" simply isn't part of
  // this input shape, so this really reduces to "no ImprintID attributes present."
  const result = runCartTransform(input([attributeLine("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/5", 1)]), SECRET, NOW);
  assert.deepEqual(result.operations, []);
});

// 10. One configured cart line
test("10. a single valid, configured cart line produces exactly one lineExpand operation", () => {
  const payload = buildPayload();
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET, NOW);
  assert.equal(result.operations.length, 1);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    assert.equal(op.lineExpand.cartLineId, "gid://shopify/CartLine/1");
    assert.equal(op.lineExpand.expandedCartItems.length, 3); // base + per-unit surcharge + flat surcharge
  }
});

test("the expanded items exactly reconstruct the original signed total (no rounding drift)", () => {
  const payload = buildPayload({ quantity: 750, baseUnitPriceCents: 113, perUnitSurchargeCents: 24, flatSurchargeCents: 8900 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET, NOW);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if (!("lineExpand" in op) || !op.lineExpand) return;

  let reconstructedCents = 0;
  for (const item of op.lineExpand.expandedCartItems) {
    const amount = Number(item.price!.adjustment.fixedPricePerUnit.amount);
    reconstructedCents += Math.round(amount * 100) * item.quantity;
  }
  const expectedTotal =
    payload.baseUnitPriceCents * payload.quantity + payload.perUnitSurchargeCents * payload.quantity + payload.flatSurchargeCents;
  assert.equal(reconstructedCents, expectedTotal);
});

// 11. Multiple configured cart lines — each independently priced, never global/first-line
test("11. multiple independently configured cart lines each get their own correct operation", () => {
  const payloadA = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/1", quantity: 500, baseUnitPriceCents: 113 });
  const payloadB = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/2", quantity: 2000, baseUnitPriceCents: 73, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });

  const result = runCartTransform(
    input([signedLine("gid://shopify/CartLine/1", payloadA), signedLine("gid://shopify/CartLine/2", payloadB)]),
    SECRET,
    NOW,
  );

  assert.equal(result.operations.length, 2);
  const lineIds = result.operations.map((op) => ("lineExpand" in op && op.lineExpand ? op.lineExpand.cartLineId : null));
  assert.deepEqual(new Set(lineIds), new Set(["gid://shopify/CartLine/1", "gid://shopify/CartLine/2"]));

  const opB = result.operations.find((op) => "lineExpand" in op && op.lineExpand?.cartLineId === "gid://shopify/CartLine/2");
  assert.ok(opB && "lineExpand" in opB && opB.lineExpand);
  if (opB && "lineExpand" in opB && opB.lineExpand) {
    // payloadB has zero surcharges -> only the base item, never picking up payloadA's numbers
    assert.equal(opB.lineExpand.expandedCartItems.length, 1);
    assert.equal(opB.lineExpand.expandedCartItems[0]!.price!.adjustment.fixedPricePerUnit.amount, "0.73");
  }
});

// Exact quantity matrix requested for final validation: never scale an untrusted quantity.
test("quantity matrix: signed 1 -> cart 1 valid, cart 2 invalid; signed 5 -> cart 5 valid, cart 4/10 invalid", () => {
  const cases: Array<{ signedQuantity: number; cartQuantity: number; expectValid: boolean }> = [
    { signedQuantity: 1, cartQuantity: 1, expectValid: true },
    { signedQuantity: 1, cartQuantity: 2, expectValid: false },
    { signedQuantity: 5, cartQuantity: 5, expectValid: true },
    { signedQuantity: 5, cartQuantity: 4, expectValid: false },
    { signedQuantity: 5, cartQuantity: 10, expectValid: false },
  ];

  for (const { signedQuantity, cartQuantity, expectValid } of cases) {
    const payload = buildPayload({ quantity: signedQuantity, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
    const line = signedLine("gid://shopify/CartLine/1", payload);
    // Override the cart line's actual quantity to simulate the browser sending a
    // different quantity than what the server signed for.
    const tamperedLine = { ...line, quantity: cartQuantity };
    const result = runCartTransform(input([tamperedLine]), SECRET, NOW);
    assert.equal(
      result.operations.length > 0,
      expectValid,
      `signed=${signedQuantity} cart=${cartQuantity} expected valid=${expectValid}`,
    );
  }
});

// Exact A/B/C/D scenario requested for final validation.
test("A/B/C/D: two valid ImprintID lines, one normal line, one tampered line — only A and B transform", () => {
  const payloadA = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/A", quantity: 100, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const payloadB = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/B", quantity: 200, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const payloadD = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/D", quantity: 300, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });

  const lineA = signedLine("gid://shopify/CartLine/A", payloadA);
  const lineB = signedLine("gid://shopify/CartLine/B", payloadB);
  const lineC = attributeLine("gid://shopify/CartLine/C", "gid://shopify/ProductVariant/C", 1); // normal Shopify product
  const lineDSigned = signedLine("gid://shopify/CartLine/D", payloadD);
  const lineD = { ...lineDSigned, payload: { value: JSON.stringify({ ...payloadD, baseUnitPriceCents: 1 }) } }; // tampered after signing

  const result = runCartTransform(input([lineA, lineB, lineC, lineD]), SECRET, NOW);

  const transformedIds = result.operations
    .map((op) => ("lineExpand" in op && op.lineExpand ? op.lineExpand.cartLineId : null))
    .filter((id): id is string => id !== null);

  assert.deepEqual(new Set(transformedIds), new Set(["gid://shopify/CartLine/A", "gid://shopify/CartLine/B"]));
  assert.equal(result.operations.length, 2); // exactly A and B — C and D never appear
});

test("a mix of one valid ImprintID line and one normal line only transforms the valid one", () => {
  const payload = buildPayload();
  const result = runCartTransform(
    input([
      signedLine("gid://shopify/CartLine/1", payload),
      attributeLine("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/50", 3),
    ]),
    SECRET,
    NOW,
  );
  assert.equal(result.operations.length, 1);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand?.cartLineId === "gid://shopify/CartLine/1");
});

// 16. Different calculated prices produce genuinely different amounts (not a fixed/stubbed number)
test("16. different signed prices produce different expanded item amounts", () => {
  const cheap = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/1", baseUnitPriceCents: 50, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const expensive = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/2", baseUnitPriceCents: 500, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });

  const result = runCartTransform(
    input([signedLine("gid://shopify/CartLine/1", cheap), signedLine("gid://shopify/CartLine/2", expensive)]),
    SECRET,
    NOW,
  );

  const amounts = result.operations.map((op) =>
    "lineExpand" in op && op.lineExpand ? op.lineExpand.expandedCartItems[0]!.price!.adjustment.fixedPricePerUnit.amount : null,
  );
  assert.deepEqual(new Set(amounts), new Set(["0.50", "5.00"]));
});

// 17. Multiple quantities
test("17. the base item's quantity always matches the signed quantity, for a range of magnitudes", () => {
  for (const quantity of [1, 100, 1999, 2000]) {
    const payload = buildPayload({ quantity, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
    const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET, NOW);
    const op = result.operations[0]!;
    assert.ok("lineExpand" in op && op.lineExpand);
    if ("lineExpand" in op && op.lineExpand) {
      assert.equal(op.lineExpand.expandedCartItems[0]!.quantity, quantity);
    }
  }
});

// 18. Decimal prices/currency precision
test("18. odd, non-round-dollar cent amounts are represented exactly, not rounded to a whole dollar", () => {
  const payload = buildPayload({ baseUnitPriceCents: 137, perUnitSurchargeCents: 7, flatSurchargeCents: 4501 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET, NOW);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if (!("lineExpand" in op) || !op.lineExpand) return;
  const amounts = op.lineExpand.expandedCartItems.map((i) => i.price!.adjustment.fixedPricePerUnit.amount);
  assert.deepEqual(amounts, ["1.37", "0.07", "45.01"]);
});

test("a surcharge component is omitted entirely (not sent as a zero-amount item) when it's zero", () => {
  const payload = buildPayload({ perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET, NOW);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    assert.equal(op.lineExpand.expandedCartItems.length, 1);
  }
});

// 19-21. Tampering — end-to-end through the whole function, not just verify-payload directly
test("19-21. any tampering anywhere in the signed payload leaves the cart line untouched, not mispriced", () => {
  const payload = buildPayload();
  const line = signedLine("gid://shopify/CartLine/1", payload);
  // Tamper with the payload attribute's value after "signing" (simulating a client
  // trying to rewrite the cart attribute directly via the Storefront Cart API).
  const tamperedPayload = JSON.stringify({ ...payload, baseUnitPriceCents: 1 });
  const tamperedLine = { ...line, payload: { value: tamperedPayload } };

  const result = runCartTransform(input([tamperedLine]), SECRET, NOW);
  assert.deepEqual(result.operations, []);
});

// 22. Replay/expired
test("22. an expired signed payload is never applied, even though it's genuinely signed", () => {
  const payload = buildPayload({ expiresAt: NOW - 1 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET, NOW);
  assert.deepEqual(result.operations, []);
});

test("a payload signed with the wrong secret is never applied", () => {
  const payload = buildPayload();
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload, "wrong-secret")]), SECRET, NOW);
  assert.deepEqual(result.operations, []);
});
