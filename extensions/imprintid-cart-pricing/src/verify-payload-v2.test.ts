import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  verifyCartPricingAttributesV2,
  parseShopEnforcementPolicy,
  parseProductPricingPolicy,
  type ShopEnforcementPolicy,
  type ProductPricingPolicy,
} from "./verify-payload-v2.ts";
import { canonicalizeCartPricingPayloadV2 } from "./cart-pricing-contract.ts";
import { normalizeConfig } from "./config-normalization.ts";
import { signHex } from "./hmac-sha256.ts";

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../test/fixtures/signed-quote-vectors-v2.json", import.meta.url), "utf8"),
) as {
  secret: string;
  vectors: Array<{
    name: string;
    payloadJson: string;
    configJson: string;
    signature: string;
    line: { quantity: number; variantGid: string | null; productGid: string | null; currencyCode: string | null };
    shopPolicy: ShopEnforcementPolicy;
    productPolicy: ProductPricingPolicy;
    expect: string;
  }>;
};

// ---------------------------------------------------------------------------
// Golden vectors — the Function verifier's side. Same file the application
// signer asserts against (app/lib/pricing-api/cart-pricing-contract.test.ts).
// ---------------------------------------------------------------------------

test("golden vectors: verifyCartPricingAttributesV2 outcome matches `expect` for every vector", () => {
  for (const v of VECTORS.vectors) {
    const result = verifyCartPricingAttributesV2(
      VECTORS.secret,
      v.line,
      { version: "2", payload: v.payloadJson, signature: v.signature, config: v.configJson },
      v.shopPolicy,
      v.productPolicy,
    );
    if (v.expect === "valid") {
      assert.equal(result.ok, true, `${v.name}: expected ok`);
    } else {
      assert.equal(result.ok, false, `${v.name}: expected rejection`);
      if (!result.ok) assert.equal(result.reason, v.expect, v.name);
    }
  }
});

test("golden vectors: server and Function canonicalization produce byte-identical strings", () => {
  for (const v of VECTORS.vectors) {
    let payload: unknown;
    try {
      payload = JSON.parse(v.payloadJson);
    } catch {
      continue;
    }
    if (typeof payload !== "object" || payload === null) continue;
    // Only meaningful for well-shaped payloads; the fixture stores the server's canonical.
    if (v.name === "unknown-extra-field" || v.name === "missing-required-field") continue;
    const canonical = canonicalizeCartPricingPayloadV2(payload as never);
    const resigned = signHex(VECTORS.secret, canonical);
    if (v.expect !== "bad_signature") {
      assert.equal(resigned, v.signature, v.name);
    }
  }
});

test("golden vectors: the Function's config-digest recomputation matches the server's for valid vectors", () => {
  for (const v of VECTORS.vectors) {
    if (v.expect !== "valid") continue;
    const payload = JSON.parse(v.payloadJson) as { configDigest: string };
    const parsed = JSON.parse(v.configJson) as unknown;
    const n = normalizeConfig(parsed);
    assert.ok(n.ok, v.name);
    if (n.ok) assert.equal(n.digest, payload.configDigest, v.name);
  }
});

// ---------------------------------------------------------------------------
// Policy metafield parsing — fail closed on anything malformed
// ---------------------------------------------------------------------------

const GOOD_ADJ = "gid://shopify/ProductVariant/999";

const VALID_SHOP = {
  schema: 1, mode: "universal", enabled: true, allowLegacyV1: false,
  adjustmentVariantGid: GOOD_ADJ, installBinding: "inst-1", policyRevision: 3,
};

test("parseShopEnforcementPolicy: accepts a complete valid policy and defaults allowLegacyV1 to false when absent", () => {
  assert.deepEqual(parseShopEnforcementPolicy(VALID_SHOP), VALID_SHOP);
  const { allowLegacyV1, ...withoutFlag } = VALID_SHOP;
  void allowLegacyV1;
  assert.deepEqual(parseShopEnforcementPolicy(withoutFlag), VALID_SHOP);
  assert.deepEqual(parseShopEnforcementPolicy({ ...VALID_SHOP, mode: "pilot", allowLegacyV1: true }), { ...VALID_SHOP, mode: "pilot", allowLegacyV1: true });
});

test("parseShopEnforcementPolicy: fails closed for every missing/invalid field, unknown key, unknown mode, and oversize input", () => {
  const cases: unknown[] = [
    null,
    "string",
    [],
    { ...VALID_SHOP, mode: "legacy" }, // unknown mode
    { ...VALID_SHOP, schema: 2 }, // wrong schema
    { ...VALID_SHOP, schema: 0 }, // non-positive schema
    (() => { const c: Record<string, unknown> = { ...VALID_SHOP }; delete c.schema; return c; })(),
    { ...VALID_SHOP, enabled: "true" }, // non-boolean
    (() => { const c: Record<string, unknown> = { ...VALID_SHOP }; delete c.enabled; return c; })(),
    { ...VALID_SHOP, allowLegacyV1: "yes" }, // present but non-boolean
    { ...VALID_SHOP, adjustmentVariantGid: "gid://x" }, // not a ProductVariant GID
    { ...VALID_SHOP, adjustmentVariantGid: "999" }, // bare id
    { ...VALID_SHOP, adjustmentVariantGid: "" },
    { ...VALID_SHOP, installBinding: "" },
    { ...VALID_SHOP, installBinding: "x".repeat(300) }, // over-long
    { ...VALID_SHOP, policyRevision: 0 }, // not positive
    { ...VALID_SHOP, policyRevision: -1 },
    { ...VALID_SHOP, policyRevision: 1.5 },
    { ...VALID_SHOP, policyRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...VALID_SHOP, attackerField: 1 }, // unknown key
    { ...VALID_SHOP, installBinding: "x".repeat(4000) }, // over size budget
  ];
  for (const c of cases) {
    assert.equal(parseShopEnforcementPolicy(c), null, JSON.stringify(c)?.slice(0, 80));
  }
});

test("parseProductPricingPolicy: accepts a complete policy; fails closed for every missing/invalid field + unknown key", () => {
  const VALID = { schema: 1, required: true, profileRef: "prof_LNY01", profileRevision: 12, active: true, policyRevision: 7 };
  assert.deepEqual(parseProductPricingPolicy(VALID), VALID);
  const cases: unknown[] = [
    null,
    { schema: 1, required: true }, // missing fields
    { ...VALID, schema: 2 },
    { ...VALID, required: "yes" },
    { ...VALID, active: 1 },
    { ...VALID, profileRef: "" },
    { ...VALID, profileRef: "x".repeat(300) },
    { ...VALID, profileRevision: 0 },
    { ...VALID, profileRevision: -3 },
    { ...VALID, policyRevision: 1.1 },
    { ...VALID, extra: true }, // unknown key
  ];
  for (const c of cases) assert.equal(parseProductPricingPolicy(c), null, JSON.stringify(c)?.slice(0, 80));
});

// ---------------------------------------------------------------------------
// Targeted fail-closed cases beyond the golden vectors
// ---------------------------------------------------------------------------

const SECRET = "unit-secret";
const SHOP: ShopEnforcementPolicy = {
  schema: 1, mode: "pilot", enabled: true, allowLegacyV1: false,
  adjustmentVariantGid: "gid://shopify/ProductVariant/999",
  installBinding: "inst-1", policyRevision: 7,
};
const PROD: ProductPricingPolicy = {
  schema: 1, required: true, profileRef: "prof_LNY01", profileRevision: 12, active: true, policyRevision: 7,
};

function makeValid() {
  const cfg = { quantity: 5, optionValueIds: ["a"], decorationMethod: "SCREEN_PRINT" };
  const n = normalizeConfig(cfg);
  if (!n.ok) throw new Error("fixture");
  const payload = {
    v: 2 as const,
    installBinding: "inst-1",
    productGid: "gid://shopify/Product/1",
    variantGid: "gid://shopify/ProductVariant/2",
    quantity: 5,
    currency: "USD",
    baseUnitPriceCents: 100,
    perUnitSurchargeCents: 0,
    flatSurchargeCents: 0,
    lineTotalCents: 500,
    adjustmentVariantGid: "gid://shopify/ProductVariant/999",
    profileRef: "prof_LNY01",
    profileRevision: 12,
    policyRevision: 7,
    configDigest: n.digest,
    quoteId: "q-1",
    issuedAtServer: 1,
  };
  return {
    payload,
    configJson: n.canonicalJson,
    signature: signHex(SECRET, canonicalizeCartPricingPayloadV2(payload)),
    line: { quantity: 5, variantGid: "gid://shopify/ProductVariant/2", productGid: "gid://shopify/Product/1", currencyCode: "USD" as string | null },
  };
}

function verify(f: ReturnType<typeof makeValid>) {
  return verifyCartPricingAttributesV2(
    SECRET,
    f.line,
    { version: "2", payload: JSON.stringify(f.payload), signature: f.signature, config: f.configJson },
    SHOP,
    PROD,
  );
}

test("a fully-valid v2 quote verifies", () => {
  assert.equal(verify(makeValid()).ok, true);
});

test("missing config attribute fails closed", () => {
  const f = makeValid();
  const r = verifyCartPricingAttributesV2(SECRET, f.line, { version: "2", payload: JSON.stringify(f.payload), signature: f.signature, config: null }, SHOP, PROD);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing");
});

test("wrong attribute version (1 not 2) is rejected as unsupported_version", () => {
  const f = makeValid();
  const r = verifyCartPricingAttributesV2(SECRET, f.line, { version: "1", payload: JSON.stringify(f.payload), signature: f.signature, config: f.configJson }, SHOP, PROD);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "unsupported_version");
});

test("Task 5B.3B.2: a cart line with NO currency FAILS CLOSED on an enforced quote (currency_context_unavailable)", () => {
  const f = makeValid();
  f.line.currencyCode = null;
  const r = verify(f);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "currency_context_unavailable");
});

test("Task 5B.3B.2: a malformed cart currency ('US Dollars', 'usd', '') fails closed (currency_context_unavailable)", () => {
  for (const bad of ["US Dollars", "", "  ", "US"]) {
    const f = makeValid();
    f.line.currencyCode = bad;
    const r = verify(f);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.equal(r.reason, "currency_context_unavailable", JSON.stringify(bad));
  }
});

test("a currency mismatch fails closed when the cart line exposes a different currency", () => {
  const f = makeValid();
  f.line.currencyCode = "EUR";
  const r = verify(f);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "currency_mismatch");
});

test("Task 5B.3B.2: currency comparison is case-insensitive after normalization ('usd' cart == 'USD' quote)", () => {
  const f = makeValid();
  f.line.currencyCode = "usd";
  assert.equal(verify(f).ok, true);
});
