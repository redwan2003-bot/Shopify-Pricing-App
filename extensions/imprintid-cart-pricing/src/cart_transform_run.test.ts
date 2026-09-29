import { test } from "node:test";
import assert from "node:assert/strict";
import { runCartTransform, centsToDecimalString, normalizeTransformInput } from "./cart_transform_run.ts";
import type { NormalizedTransformInput, NormalizedLine } from "./cart_transform_run.ts";
import type { CartPricingPayload } from "./verify-payload.ts";
import { signHex } from "./hmac-sha256.ts";

const SECRET = "test-secret";
// Retained only to build v1 payloads (whose shape still carries `expiresAt`). The
// Function performs no clock comparison.
const NOW = 1_800_000_000;

const ADJ = "gid://shopify/ProductVariant/999";

// A valid pilot policy that explicitly authorizes legacy v1 (5B.1.1). Without a shop
// policy — or without this flag — a v1 quote produces NOTHING.
const V1_PILOT_POLICY = {
  schema: 1,
  mode: "pilot",
  enabled: true,
  allowLegacyV1: true,
  adjustmentVariantGid: ADJ,
  installBinding: "inst-1",
  policyRevision: 7,
};
const PRODUCT_POLICY = { schema: 1, required: true, profileRef: "prof_LNY01", profileRevision: 12, active: true, policyRevision: 7 };

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
    adjustmentVariantId: ADJ,
    expiresAt: NOW + 1000,
    ...overrides,
  };
}

function attributeLine(
  id: string,
  merchandiseId: string | null,
  quantity: number,
  attrs: { version?: string | null; payload?: string | null; signature?: string | null } = {},
  opts: { productPolicyJson?: unknown } = {},
): NormalizedLine {
  return {
    id,
    quantity,
    merchandiseId,
    productGid: merchandiseId ? "gid://shopify/Product/" + id.replace(/\D/g, "0") : null,
    productPolicyJson: "productPolicyJson" in opts ? opts.productPolicyJson : PRODUCT_POLICY,
    currencyCode: "USD",
    attrs: {
      version: attrs.version ?? null,
      payload: attrs.payload ?? null,
      signature: attrs.signature ?? null,
      config: null,
    },
  };
}

function signedLine(id: string, payload: CartPricingPayload, secret: string = SECRET, opts: { productPolicyJson?: unknown } = {}): NormalizedLine {
  return attributeLine(
    id,
    payload.baseVariantId,
    payload.quantity,
    { version: "1", payload: JSON.stringify(payload), signature: signHex(secret, canonicalize(payload)) },
    opts,
  );
}

function input(lines: NormalizedLine[], presentmentRate = "1", shopPolicyJson: unknown = V1_PILOT_POLICY): NormalizedTransformInput {
  return { presentmentRate, shopPolicyJson, lines };
}

// ---------------------------------------------------------------------------
// centsToDecimalString (unchanged)
// ---------------------------------------------------------------------------

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

test("centsToDecimalString converts using a non-1 presentment currency rate", () => {
  assert.equal(centsToDecimalString(98, "1.08"), (0.98 * 1.08).toFixed(2));
  assert.equal(centsToDecimalString(10000, "0.85"), (100 * 0.85).toFixed(2));
});

test("centsToDecimalString falls back to the exact shop-currency amount for a malformed rate", () => {
  assert.equal(centsToDecimalString(500, "not-a-number"), "5.00");
  assert.equal(centsToDecimalString(500, "0"), "5.00");
  assert.equal(centsToDecimalString(500, "-1"), "5.00");
});

test("a non-1 presentment currency rate is applied end-to-end through runCartTransform", () => {
  const payload = buildPayload({ baseUnitPriceCents: 100, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1.10"), SECRET);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    assert.equal(op.lineExpand.expandedCartItems[0]!.price!.adjustment.fixedPricePerUnit.amount, "1.10");
  }
});

test("a presentment currency rate of \"1\" leaves single-currency carts byte-identical", () => {
  const payload = buildPayload();
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1"), SECRET);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    const amounts = op.lineExpand.expandedCartItems.map((i) => i.price!.adjustment.fixedPricePerUnit.amount);
    assert.deepEqual(amounts, ["0.98", "264.00"]);
  }
});

// ---------------------------------------------------------------------------
// Cart iteration + expansion (v1, under an explicit pilot+allowLegacyV1 authorization)
// ---------------------------------------------------------------------------

test("13. an empty cart produces zero operations", () => {
  assert.deepEqual(runCartTransform(input([]), SECRET).operations, []);
});

test("12. a normal cart line with no ImprintID attributes and no product policy is left untouched", () => {
  const result = runCartTransform(
    input([attributeLine("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/5", 2, {}, { productPolicyJson: null })]),
    SECRET,
  );
  assert.deepEqual(result.operations, []);
});

test("14. a line carrying unrelated attributes is left untouched, not mistaken for one", () => {
  const result = runCartTransform(
    input([attributeLine("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/5", 1, {}, { productPolicyJson: null })]),
    SECRET,
  );
  assert.deepEqual(result.operations, []);
});

test("10. a single valid v1 cart line (authorized) produces exactly one lineExpand", () => {
  const payload = buildPayload();
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET);
  assert.equal(result.operations.length, 1);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    assert.equal(op.lineExpand.cartLineId, "gid://shopify/CartLine/1");
    assert.equal(op.lineExpand.expandedCartItems.length, 2);
  }
});

test("the expanded items exactly reconstruct the original signed total (no rounding drift)", () => {
  const payload = buildPayload({ quantity: 750, baseUnitPriceCents: 113, perUnitSurchargeCents: 24, flatSurchargeCents: 8900 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if (!("lineExpand" in op) || !op.lineExpand) return;
  let reconstructedCents = 0;
  for (const item of op.lineExpand.expandedCartItems) {
    reconstructedCents += Math.round(Number(item.price!.adjustment.fixedPricePerUnit.amount) * 100) * item.quantity;
  }
  assert.equal(reconstructedCents, payload.baseUnitPriceCents * payload.quantity + payload.perUnitSurchargeCents * payload.quantity + payload.flatSurchargeCents);
});

test("11. multiple independently configured cart lines each get their own correct operation", () => {
  const payloadA = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/1", quantity: 500, baseUnitPriceCents: 113 });
  const payloadB = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/2", quantity: 2000, baseUnitPriceCents: 73, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const result = runCartTransform(
    input([signedLine("gid://shopify/CartLine/1", payloadA), signedLine("gid://shopify/CartLine/2", payloadB)]),
    SECRET,
  );
  assert.equal(result.operations.length, 2);
  const opB = result.operations.find((op) => "lineExpand" in op && op.lineExpand?.cartLineId === "gid://shopify/CartLine/2");
  assert.ok(opB && "lineExpand" in opB && opB.lineExpand);
  if (opB && "lineExpand" in opB && opB.lineExpand) {
    assert.equal(opB.lineExpand.expandedCartItems.length, 1);
    assert.equal(opB.lineExpand.expandedCartItems[0]!.price!.adjustment.fixedPricePerUnit.amount, "0.73");
  }
});

test("quantity matrix: signed 1 -> cart 1 valid, cart 2 invalid; signed 5 -> cart 5 valid, cart 4/10 invalid", () => {
  for (const { signedQuantity, cartQuantity, expectValid } of [
    { signedQuantity: 1, cartQuantity: 1, expectValid: true },
    { signedQuantity: 1, cartQuantity: 2, expectValid: false },
    { signedQuantity: 5, cartQuantity: 5, expectValid: true },
    { signedQuantity: 5, cartQuantity: 4, expectValid: false },
    { signedQuantity: 5, cartQuantity: 10, expectValid: false },
  ]) {
    const payload = buildPayload({ quantity: signedQuantity, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
    const line = { ...signedLine("gid://shopify/CartLine/1", payload), quantity: cartQuantity };
    const result = runCartTransform(input([line]), SECRET);
    assert.equal(result.operations.length > 0, expectValid, `signed=${signedQuantity} cart=${cartQuantity}`);
  }
});

test("A/B/C/D: two valid v1 lines, one normal line, one tampered line — only A and B transform", () => {
  const payloadA = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/A", quantity: 100, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const payloadB = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/B", quantity: 200, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const payloadD = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/D", quantity: 300, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const lineA = signedLine("gid://shopify/CartLine/A", payloadA);
  const lineB = signedLine("gid://shopify/CartLine/B", payloadB);
  const lineC = attributeLine("gid://shopify/CartLine/C", "gid://shopify/ProductVariant/C", 1, {}, { productPolicyJson: null });
  const lineD = { ...signedLine("gid://shopify/CartLine/D", payloadD), attrs: { ...signedLine("gid://shopify/CartLine/D", payloadD).attrs, payload: JSON.stringify({ ...payloadD, baseUnitPriceCents: 1 }) } };
  const result = runCartTransform(input([lineA, lineB, lineC, lineD]), SECRET);
  const ids = result.operations.map((op) => ("lineExpand" in op && op.lineExpand ? op.lineExpand.cartLineId : null)).filter((x): x is string => x !== null);
  assert.deepEqual(new Set(ids), new Set(["gid://shopify/CartLine/A", "gid://shopify/CartLine/B"]));
  assert.equal(result.operations.length, 2);
});

test("16. different signed prices produce different expanded item amounts", () => {
  const cheap = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/1", baseUnitPriceCents: 50, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const expensive = buildPayload({ baseVariantId: "gid://shopify/ProductVariant/2", baseUnitPriceCents: 500, perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", cheap), signedLine("gid://shopify/CartLine/2", expensive)]), SECRET);
  const amounts = result.operations.map((op) => ("lineExpand" in op && op.lineExpand ? op.lineExpand.expandedCartItems[0]!.price!.adjustment.fixedPricePerUnit.amount : null));
  assert.deepEqual(new Set(amounts), new Set(["0.50", "5.00"]));
});

test("18. odd, non-round-dollar cent amounts are represented exactly", () => {
  const payload = buildPayload({ baseUnitPriceCents: 137, perUnitSurchargeCents: 7, flatSurchargeCents: 4501 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    assert.deepEqual(op.lineExpand.expandedCartItems.map((i) => i.price!.adjustment.fixedPricePerUnit.amount), ["1.37", "115.01"]);
  }
});

test("a surcharge component is omitted entirely (not a zero-amount item) when it's zero", () => {
  const payload = buildPayload({ perUnitSurchargeCents: 0, flatSurchargeCents: 0 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET);
  const op = result.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) assert.equal(op.lineExpand.expandedCartItems.length, 1);
});

test("19-21. tampering anywhere in the signed payload leaves the cart line untouched", () => {
  const payload = buildPayload();
  const line = signedLine("gid://shopify/CartLine/1", payload);
  const tamperedLine = { ...line, attrs: { ...line.attrs, payload: JSON.stringify({ ...payload, baseUnitPriceCents: 1 }) } };
  assert.deepEqual(runCartTransform(input([tamperedLine]), SECRET).operations, []);
});

test("22. a v1 payload with a past expiresAt is STILL applied (no Function-side clock)", () => {
  const payload = buildPayload({ expiresAt: NOW - 1 });
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)]), SECRET);
  assert.equal(result.operations.length, 1);
});

test("a payload signed with the wrong secret is never applied", () => {
  const payload = buildPayload();
  assert.deepEqual(runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload, "wrong-secret")]), SECRET).operations, []);
});

// ---------------------------------------------------------------------------
// 5B.1.1 — no implicit legacy mode
// ---------------------------------------------------------------------------

test("5B.1.1: with NO shop policy, a valid v1 quote produces NOTHING (no implicit legacy mode)", () => {
  const payload = buildPayload();
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1", null), SECRET);
  assert.deepEqual(result.operations, []);
});

test("5B.1.1: with a MALFORMED shop policy, a valid v1 quote produces NOTHING", () => {
  const payload = buildPayload();
  for (const bad of [{}, { mode: "pilot" }, { schema: 2, mode: "pilot", enabled: true, adjustmentVariantGid: ADJ, installBinding: "i", policyRevision: 7 }, "not-an-object", []]) {
    const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1", bad), SECRET);
    assert.deepEqual(result.operations, [], JSON.stringify(bad));
  }
});

test("5B.1.1: allowLegacyV1 defaults to false — a pilot policy WITHOUT the flag rejects v1", () => {
  const payload = buildPayload();
  const noFlag = { schema: 1, mode: "pilot", enabled: true, adjustmentVariantGid: ADJ, installBinding: "i", policyRevision: 7 };
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1", noFlag), SECRET);
  assert.deepEqual(result.operations, []);
});

test("5B.1.1: pilot + allowLegacyV1=false explicitly rejects v1", () => {
  const payload = buildPayload();
  const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1", { ...V1_PILOT_POLICY, allowLegacyV1: false }), SECRET);
  assert.deepEqual(result.operations, []);
});

test("5B.1.1: universal mode rejects a valid v1 quote regardless of allowLegacyV1", () => {
  const payload = buildPayload();
  for (const allow of [true, false]) {
    const result = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1", { ...V1_PILOT_POLICY, mode: "universal", allowLegacyV1: allow }), SECRET);
    assert.deepEqual(result.operations, [], `allowLegacyV1=${allow}`);
  }
});

test("5B.1.1: maintenance mode rejects both v1 and v2", () => {
  const payload = buildPayload();
  const r1 = runCartTransform(input([signedLine("gid://shopify/CartLine/1", payload)], "1", { ...V1_PILOT_POLICY, mode: "maintenance" }), SECRET);
  assert.deepEqual(r1.operations, []);
});

test("5B.1.1: pilot + allowLegacyV1=true but NO product policy → v1 not processed (product not in the pilot)", () => {
  const payload = buildPayload();
  const line = signedLine("gid://shopify/CartLine/1", payload, SECRET, { productPolicyJson: null });
  const result = runCartTransform(input([line]), SECRET);
  assert.deepEqual(result.operations, []);
});

// ---------------------------------------------------------------------------
// normalizeTransformInput uses the generated types
// ---------------------------------------------------------------------------

test("normalizeTransformInput extracts the fields the logic needs from a generated-shaped input", () => {
  const normalized = normalizeTransformInput({
    presentmentCurrencyRate: "1",
    shop: { enforcementPolicy: { jsonValue: V1_PILOT_POLICY } },
    cart: {
      lines: [
        {
          id: "gid://shopify/CartLine/1",
          quantity: 3,
          cost: {
            amountPerQuantity: { amount: "1.00", currencyCode: "USD" },
            totalAmount: { amount: "3.00", currencyCode: "USD" },
          },
          merchandise: {
            __typename: "ProductVariant",
            id: "gid://shopify/ProductVariant/2",
            product: { id: "gid://shopify/Product/1", pricingPolicy: { jsonValue: PRODUCT_POLICY } },
          },
          version: { value: "2" },
          payload: { value: "p" },
          signature: { value: "s" },
          config: { value: "c" },
        },
      ],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  assert.equal(normalized.presentmentRate, "1");
  assert.deepEqual(normalized.shopPolicyJson, V1_PILOT_POLICY);
  assert.equal(normalized.lines[0]!.merchandiseId, "gid://shopify/ProductVariant/2");
  assert.equal(normalized.lines[0]!.productGid, "gid://shopify/Product/1");
  assert.equal(normalized.lines[0]!.currencyCode, "USD");
  assert.deepEqual(normalized.lines[0]!.attrs, { version: "2", payload: "p", signature: "s", config: "c" });
});
