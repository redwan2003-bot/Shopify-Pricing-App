import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { runCartTransform } from "./cart_transform_run.ts";
import type { NormalizedTransformInput, NormalizedLine } from "./cart_transform_run.ts";
import { canonicalizeCartPricingPayloadV2 } from "./cart-pricing-contract.ts";
import { normalizeConfig } from "./config-normalization.ts";
import { signHex } from "./hmac-sha256.ts";

const SECRET = "hardening-secret";
const ADJ = "gid://shopify/ProductVariant/999";
const PRODUCT = "gid://shopify/Product/1";
const VARIANT = "gid://shopify/ProductVariant/2";
const INSTALL = "inst-1";

const PRODUCT_POLICY = { schema: 1, required: true, profileRef: "prof_LNY01", profileRevision: 12, active: true, policyRevision: 7 };

function shopPolicy(mode: string, over: Record<string, unknown> = {}): unknown {
  return {
    schema: 1,
    mode,
    enabled: true,
    allowLegacyV1: false,
    adjustmentVariantGid: ADJ,
    installBinding: INSTALL,
    policyRevision: 7,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// §7A — the Function source contains no clock use
// ---------------------------------------------------------------------------

test("§7A: Date.now(), an injected `now`, and `expiresAt` comparisons are absent from the Function's run-path CODE", () => {
  const dir = new URL(".", import.meta.url);
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const file of files) {
    const code = stripComments(readFileSync(new URL(file, dir), "utf8"));
    assert.ok(!/Date\.now\s*\(/.test(code), `${file} code must not call Date.now()`);
    assert.ok(!/\bperformance\.now\s*\(/.test(code), `${file} code must not call performance.now()`);
    assert.ok(!/\bMath\.random\s*\(/.test(code), `${file} code must not call Math.random()`);
  }
  const runCode = stripComments(readFileSync(new URL("cart_transform_run.ts", dir), "utf8"));
  assert.ok(!/function runCartTransform\([^)]*\bnow\b/.test(runCode), "runCartTransform takes no `now` parameter");
  assert.ok(!/expiresAt/.test(runCode), "no expiresAt reference remains in the run-path code");
});

// ---------------------------------------------------------------------------
// Line + input builders (5B.1.1 normalized shape — uses the generated types upstream)
// ---------------------------------------------------------------------------

function v2Line(id: string, over: Record<string, unknown> = {}, opts: { productPolicyJson?: unknown } = {}): NormalizedLine {
  const n = normalizeConfig({ quantity: 100, optionValueIds: ["a"], decorationMethod: "SCREEN_PRINT" });
  if (!n.ok) throw new Error("fixture");
  const payload = {
    v: 2, installBinding: INSTALL, productGid: PRODUCT, variantGid: VARIANT, quantity: 100, currency: "USD",
    baseUnitPriceCents: 137, perUnitSurchargeCents: 0, flatSurchargeCents: 4500, lineTotalCents: 137 * 100 + 4500,
    adjustmentVariantGid: ADJ, profileRef: "prof_LNY01", profileRevision: 12, policyRevision: 7,
    configDigest: n.digest, quoteId: "q-1", issuedAtServer: 1, ...over,
  };
  return {
    id,
    quantity: 100,
    merchandiseId: VARIANT,
    productGid: PRODUCT,
    productPolicyJson: "productPolicyJson" in opts ? opts.productPolicyJson : PRODUCT_POLICY,
    currencyCode: "USD",
    attrs: {
      version: "2",
      payload: JSON.stringify(payload),
      signature: signHex(SECRET, canonicalizeCartPricingPayloadV2(payload as never)),
      config: n.canonicalJson,
    },
  };
}

function v1Line(id: string, over: Record<string, unknown> = {}, opts: { productPolicyJson?: unknown } = {}): NormalizedLine {
  const payload = {
    v: 1, sku: "LNY01", quantity: 100, currency: "USD", baseVariantId: VARIANT,
    baseUnitPriceCents: 137, perUnitSurchargeCents: 0, flatSurchargeCents: 0,
    adjustmentVariantId: ADJ, expiresAt: 0, ...over,
  };
  const canonical = Object.keys(payload).sort().map((k) => `${k}=${String((payload as Record<string, unknown>)[k])}`).join("\n");
  return {
    id,
    quantity: 100,
    merchandiseId: VARIANT,
    productGid: PRODUCT,
    productPolicyJson: "productPolicyJson" in opts ? opts.productPolicyJson : PRODUCT_POLICY,
    currencyCode: "USD",
    attrs: { version: "1", payload: JSON.stringify(payload), signature: signHex(SECRET, canonical), config: null },
  };
}

function input(lines: NormalizedLine[], shopPolicyJson: unknown): NormalizedTransformInput {
  return { presentmentRate: "1", shopPolicyJson, lines };
}

// ---------------------------------------------------------------------------
// §7C — policy modes (v2)
// ---------------------------------------------------------------------------

test("§7C disabled: a valid v2 quote produces NO operation", () => {
  assert.deepEqual(runCartTransform(input([v2Line("l1")], shopPolicy("disabled")), SECRET).operations, []);
});

test("§7C kill switch (enabled:false): NO operation regardless of mode", () => {
  assert.deepEqual(runCartTransform(input([v2Line("l1")], shopPolicy("universal", { enabled: false })), SECRET).operations, []);
});

test("§7C pilot: enforced product with a valid v2 quote is expanded", () => {
  assert.equal(runCartTransform(input([v2Line("l1")], shopPolicy("pilot")), SECRET).operations.length, 1);
});

test("§7C pilot: a product WITHOUT an active required policy is not enforced", () => {
  const r = runCartTransform(
    input([v2Line("l1", {}, { productPolicyJson: { schema: 1, required: false, profileRef: "x", profileRevision: 1, active: true, policyRevision: 7 } })], shopPolicy("pilot")),
    SECRET,
  );
  assert.deepEqual(r.operations, []);
});

test("§7C universal: a valid v2 quote is expanded", () => {
  assert.equal(runCartTransform(input([v2Line("l1")], shopPolicy("universal")), SECRET).operations.length, 1);
});

test("§7C universal + MISSING product policy: NO Transform pricing operation (marked for Validation to block)", () => {
  assert.deepEqual(runCartTransform(input([v2Line("l1", {}, { productPolicyJson: null })], shopPolicy("universal")), SECRET).operations, []);
});

test("§7C universal + INACTIVE product policy: NO Transform pricing operation", () => {
  const r = runCartTransform(
    input([v2Line("l1", {}, { productPolicyJson: { ...PRODUCT_POLICY, active: false } })], shopPolicy("universal")),
    SECRET,
  );
  assert.deepEqual(r.operations, []);
});

test("§7C maintenance: enforced product with a fully valid v2 quote produces NO pricing operation", () => {
  assert.deepEqual(runCartTransform(input([v2Line("l1")], shopPolicy("maintenance")), SECRET).operations, []);
});

test("§7B: a stale profileRevision fails closed", () => {
  assert.deepEqual(runCartTransform(input([v2Line("l1", { profileRevision: 11 })], shopPolicy("pilot")), SECRET).operations, []);
});

test("§7B: a stale policyRevision fails closed", () => {
  assert.deepEqual(runCartTransform(input([v2Line("l1", { policyRevision: 6 })], shopPolicy("pilot")), SECRET).operations, []);
});

// ---------------------------------------------------------------------------
// §7D — adjustment variant
// ---------------------------------------------------------------------------

test("§7D: a cart LINE that is the adjustment variant (added directly) produces NO operation", () => {
  const directAdjLine: NormalizedLine = {
    id: "adj-line",
    quantity: 3,
    merchandiseId: ADJ,
    productGid: "gid://shopify/Product/adj",
    productPolicyJson: null,
    currencyCode: "USD",
    attrs: { version: null, payload: null, signature: null, config: null },
  };
  assert.deepEqual(runCartTransform(input([directAdjLine], shopPolicy("universal")), SECRET).operations, []);
});

test("§7D: adjustment-variant identity is taken from shop policy, not the payload", () => {
  assert.deepEqual(
    runCartTransform(input([v2Line("l1", { adjustmentVariantGid: "gid://shopify/ProductVariant/1" })], shopPolicy("pilot")), SECRET).operations,
    [],
  );
});

// ---------------------------------------------------------------------------
// §1 (5B.1.1) — no implicit legacy mode; explicit allowLegacyV1
// ---------------------------------------------------------------------------

test("5B.1.1: NO shop policy → a valid v1 quote produces NOTHING", () => {
  assert.deepEqual(runCartTransform(input([v1Line("l1")], null), SECRET).operations, []);
});

test("5B.1.1: malformed shop policy → NOTHING for v1 or v2", () => {
  assert.deepEqual(runCartTransform(input([v1Line("l1")], { mode: "pilot" }), SECRET).operations, []);
  assert.deepEqual(runCartTransform(input([v2Line("l1")], { mode: "pilot" }), SECRET).operations, []);
});

test("5B.1.1: pilot + allowLegacyV1=true + product policy → a valid v1 fixture IS processed", () => {
  assert.equal(runCartTransform(input([v1Line("l1")], shopPolicy("pilot", { allowLegacyV1: true })), SECRET).operations.length, 1);
});

test("5B.1.1: pilot + allowLegacyV1=false → v1 rejected", () => {
  assert.deepEqual(runCartTransform(input([v1Line("l1")], shopPolicy("pilot", { allowLegacyV1: false })), SECRET).operations, []);
});

test("5B.1.1: universal → v1 rejected regardless of the flag", () => {
  for (const allowLegacyV1 of [true, false]) {
    assert.deepEqual(runCartTransform(input([v1Line("l1")], shopPolicy("universal", { allowLegacyV1 })), SECRET).operations, []);
  }
});

test("5B.1.1: maintenance → v1 and v2 both rejected", () => {
  assert.deepEqual(runCartTransform(input([v1Line("l1")], shopPolicy("maintenance", { allowLegacyV1: true })), SECRET).operations, []);
  assert.deepEqual(runCartTransform(input([v2Line("l1")], shopPolicy("maintenance")), SECRET).operations, []);
});

test("5B.1.1: pilot + allowLegacyV1=true but NO product policy → v1 not processed", () => {
  const line = v1Line("l1", {}, { productPolicyJson: null });
  assert.deepEqual(runCartTransform(input([line], shopPolicy("pilot", { allowLegacyV1: true })), SECRET).operations, []);
});

test("5B.1.1: a v1 payload sent with version \"2\" is never treated as v2", () => {
  const line = v1Line("l1");
  line.attrs.version = "2";
  line.attrs.config = "{}";
  assert.deepEqual(runCartTransform(input([line], shopPolicy("pilot", { allowLegacyV1: true })), SECRET).operations, []);
});

// ---------------------------------------------------------------------------
// Pricing semantics unchanged
// ---------------------------------------------------------------------------

test("expansion amounts for a v2 quote match the signed components exactly", () => {
  const r = runCartTransform(input([v2Line("l1")], shopPolicy("pilot")), SECRET);
  assert.equal(r.operations.length, 1);
  const op = r.operations[0]!;
  assert.ok("lineExpand" in op && op.lineExpand);
  if ("lineExpand" in op && op.lineExpand) {
    assert.deepEqual(op.lineExpand.expandedCartItems.map((i) => i.price!.adjustment.fixedPricePerUnit.amount), ["1.37", "45.00"]);
    assert.equal(op.lineExpand.expandedCartItems[0]!.quantity, 100);
    assert.equal(op.lineExpand.expandedCartItems[1]!.quantity, 1);
  }
});
