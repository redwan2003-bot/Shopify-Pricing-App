import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

import {
  ENVELOPE_V2,
  V2_CANONICAL_FIELD_ORDER,
  V2_PAYLOAD_KEYS,
  ENFORCEMENT_MODES,
  canonicalizeCartPricingPayloadV2,
  checkMonetaryInvariants,
  computeLineTotalCents,
  expectedExpandedComponentCount,
  isEnforcementMode,
  customerSafeMessageFor,
  type CartPricingPayloadV2,
} from "./cart-pricing-contract.ts";
import { normalizeConfig, digestOfConfigJson } from "./config-normalization.ts";
import {
  buildCartPricingPayloadV2,
  signCartPricingPayloadV2,
  nullCartPricingPolicyProvider,
} from "./cart-signature.ts";
import { signHex } from "./hmac-sha256.ts";

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../test/fixtures/signed-quote-vectors-v2.json", import.meta.url), "utf8"),
) as {
  secret: string;
  vectors: Array<{
    name: string;
    payloadJson: string;
    configJson: string;
    canonical: string;
    signature: string;
    expect: string;
  }>;
};

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

function samplePayload(over: Partial<CartPricingPayloadV2> = {}): CartPricingPayloadV2 {
  return {
    v: ENVELOPE_V2,
    installBinding: "install-x",
    productGid: "gid://shopify/Product/1",
    variantGid: "gid://shopify/ProductVariant/2",
    quantity: 100,
    currency: "USD",
    baseUnitPriceCents: 137,
    perUnitSurchargeCents: 0,
    flatSurchargeCents: 4500,
    lineTotalCents: 137 * 100 + 4500,
    adjustmentVariantGid: "gid://shopify/ProductVariant/999",
    profileRef: "prof_LNY01",
    profileRevision: 12,
    policyRevision: 7,
    configDigest: "sha256:deadbeef",
    quoteId: "q-1",
    issuedAtServer: 1700000000,
    ...over,
  };
}

test("v2 canonicalization is deterministic and independent of object key insertion order", () => {
  const a = samplePayload();
  const shuffled: CartPricingPayloadV2 = JSON.parse(
    JSON.stringify(
      Object.fromEntries(Object.entries(a).reverse()),
    ),
  );
  assert.equal(canonicalizeCartPricingPayloadV2(a), canonicalizeCartPricingPayloadV2(shuffled));
});

test("v2 canonical field order matches the documented V2_CANONICAL_FIELD_ORDER exactly", () => {
  const canonical = canonicalizeCartPricingPayloadV2(samplePayload());
  const orderInCanonical = canonical.split("\n").map((line) => line.slice(0, line.indexOf("=")));
  assert.deepEqual(orderInCanonical, [...V2_CANONICAL_FIELD_ORDER]);
});

test("V2_PAYLOAD_KEYS and V2_CANONICAL_FIELD_ORDER describe the same field set", () => {
  assert.deepEqual([...V2_PAYLOAD_KEYS].sort(), [...V2_CANONICAL_FIELD_ORDER].sort());
});

test("HMAC-SHA256 signing matches Node's own crypto for the v2 canonical string", () => {
  const canonical = canonicalizeCartPricingPayloadV2(samplePayload());
  const ours = signHex("some-secret", canonical);
  const nodeHmac = createHmac("sha256", "some-secret").update(canonical, "utf8").digest("hex");
  assert.equal(ours, nodeHmac);
});

// ---------------------------------------------------------------------------
// Monetary invariants — derived from the lineExpand implementation
// ---------------------------------------------------------------------------

test("computeLineTotalCents = base*q + perUnit*q + flat (pure integers)", () => {
  assert.equal(computeLineTotalCents({ baseUnitPriceCents: 137, perUnitSurchargeCents: 20, flatSurchargeCents: 4500, quantity: 100 }), 137 * 100 + 20 * 100 + 4500);
  assert.equal(computeLineTotalCents({ baseUnitPriceCents: 98, perUnitSurchargeCents: 0, flatSurchargeCents: 0, quantity: 1 }), 98);
});

test("expectedExpandedComponentCount counts the base plus each NON-ZERO surcharge", () => {
  assert.equal(expectedExpandedComponentCount({ baseUnitPriceCents: 1, perUnitSurchargeCents: 0, flatSurchargeCents: 0, quantity: 1 }), 1);
  assert.equal(expectedExpandedComponentCount({ baseUnitPriceCents: 1, perUnitSurchargeCents: 5, flatSurchargeCents: 0, quantity: 1 }), 2);
  assert.equal(expectedExpandedComponentCount({ baseUnitPriceCents: 1, perUnitSurchargeCents: 5, flatSurchargeCents: 9, quantity: 1 }), 3);
});

test("checkMonetaryInvariants passes a clean set and rejects each violation with a stable code", () => {
  const clean = { baseUnitPriceCents: 137, perUnitSurchargeCents: 20, flatSurchargeCents: 4500, quantity: 100 };
  assert.equal(checkMonetaryInvariants(clean, computeLineTotalCents(clean)), null);

  assert.equal(checkMonetaryInvariants({ ...clean, baseUnitPriceCents: -1 }, 0), "monetary_invariant");
  assert.equal(checkMonetaryInvariants({ ...clean, baseUnitPriceCents: 1.5 }, 0), "monetary_invariant");
  assert.equal(checkMonetaryInvariants({ ...clean, quantity: 0 }, 0), "monetary_invariant");
  assert.equal(checkMonetaryInvariants({ ...clean, quantity: 2_000_000 }, 0), "monetary_invariant");
  assert.equal(checkMonetaryInvariants({ ...clean, baseUnitPriceCents: Number.MAX_SAFE_INTEGER }, 0), "monetary_invariant");
  assert.equal(checkMonetaryInvariants(clean, computeLineTotalCents(clean) + 1), "line_total_mismatch");
});

test("no floating-point cents: every invariant input/output is an integer", () => {
  const c = { baseUnitPriceCents: 333, perUnitSurchargeCents: 7, flatSurchargeCents: 4501, quantity: 999 };
  const total = computeLineTotalCents(c);
  assert.ok(Number.isInteger(total));
  assert.equal(total % 1, 0);
});

// ---------------------------------------------------------------------------
// Configuration normalization
// ---------------------------------------------------------------------------

test("normalizeConfig: irrelevant object-key order does not change the digest", () => {
  const a = normalizeConfig({ b: 2, a: 1, nested: { y: true, x: "s" } });
  const b = normalizeConfig({ nested: { x: "s", y: true }, a: 1, b: 2 });
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.equal(a.digest, b.digest);
});

test("normalizeConfig: a changed value changes the digest (every meaningful selection change)", () => {
  const base = normalizeConfig({ optionValueIds: ["opt-a", "opt-b"], colors: 1 });
  const changedOption = normalizeConfig({ optionValueIds: ["opt-a", "opt-c"], colors: 1 });
  const changedColors = normalizeConfig({ optionValueIds: ["opt-a", "opt-b"], colors: 2 });
  assert.ok(base.ok && changedOption.ok && changedColors.ok);
  if (base.ok && changedOption.ok && changedColors.ok) {
    assert.notEqual(base.digest, changedOption.digest);
    assert.notEqual(base.digest, changedColors.digest);
  }
});

test("normalizeConfig: array ORDER is preserved (not sorted)", () => {
  const a = normalizeConfig({ steps: ["first", "second"] });
  const b = normalizeConfig({ steps: ["second", "first"] });
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.notEqual(a.digest, b.digest);
});

test("normalizeConfig: rejects floats, non-finite, bigint, functions, class instances, symbols", () => {
  assert.equal(normalizeConfig({ price: 12.99 }).ok, false);
  assert.equal(normalizeConfig({ n: Number.NaN }).ok, false);
  assert.equal(normalizeConfig({ n: Infinity }).ok, false);
  assert.equal(normalizeConfig({ n: 10n as unknown as number }).ok, false);
  assert.equal(normalizeConfig({ f: (() => 1) as unknown as string }).ok, false);
  assert.equal(normalizeConfig({ d: new Date() as unknown as string }).ok, false);
  assert.equal(normalizeConfig({ m: new Map() as unknown as string }).ok, false);
});

test("normalizeConfig: rejects over-deep, over-wide, and over-large input", () => {
  let deep: Record<string, unknown> = { v: 1 };
  for (let i = 0; i < 12; i++) deep = { child: deep };
  assert.equal(normalizeConfig(deep).ok, false);

  const wide: Record<string, number> = {};
  for (let i = 0; i < 300; i++) wide[`k${i}`] = i;
  assert.equal(normalizeConfig(wide).ok, false);

  assert.equal(normalizeConfig({ big: ["x".repeat(9000)] }).ok, false);
});

test("normalizeConfig: null vs omitted are distinct; explicit undefined is rejected", () => {
  const withNull = normalizeConfig({ a: null });
  const withoutKey = normalizeConfig({});
  assert.ok(withNull.ok && withoutKey.ok);
  if (withNull.ok && withoutKey.ok) assert.notEqual(withNull.digest, withoutKey.digest);
  assert.equal(normalizeConfig({ a: undefined }).ok, false);
});

test("digestOfConfigJson: whitespace-different-but-equivalent JSON verifies to the same digest", () => {
  const canonical = normalizeConfig({ a: 1, b: [true, "s"] });
  assert.ok(canonical.ok);
  if (!canonical.ok) return;
  const spaced = digestOfConfigJson('{  "b" : [ true , "s" ] ,\n"a":1 }');
  assert.ok(spaced.ok);
  if (spaced.ok) assert.equal(spaced.digest, canonical.digest);
});

// ---------------------------------------------------------------------------
// Enforcement modes
// ---------------------------------------------------------------------------

test("the four enforcement modes are exactly disabled/pilot/universal/maintenance", () => {
  assert.deepEqual([...ENFORCEMENT_MODES], ["disabled", "pilot", "universal", "maintenance"]);
  assert.equal(isEnforcementMode("universal"), true);
  assert.equal(isEnforcementMode("legacy"), false);
});

test("customerSafeMessageFor never returns a code and never leaks which check failed", () => {
  for (const code of ["bad_signature", "install_mismatch", "config_digest_mismatch", "policy_missing"] as const) {
    const msg = customerSafeMessageFor(code);
    assert.ok(msg.length > 0);
    assert.ok(!msg.includes(code));
    assert.ok(!/signature|hmac|install|digest|revision/i.test(msg));
  }
});

// ---------------------------------------------------------------------------
// Golden vectors — the application signer's side
// ---------------------------------------------------------------------------

test("golden vectors: re-signing each payload with the fixture secret reproduces the fixture signature", () => {
  for (const v of VECTORS.vectors) {
    if (v.canonical === "") continue; // malformed-payload vectors carry no canonical
    const resigned = signHex(VECTORS.secret, v.canonical);
    if (v.expect === "bad_signature") {
      assert.notEqual(resigned, v.signature, v.name);
    } else {
      assert.equal(resigned, v.signature, v.name);
    }
  }
});

test("golden vectors: the payload's configDigest equals the SHA-256 of its own config JSON (valid vectors)", () => {
  for (const v of VECTORS.vectors) {
    if (v.expect !== "valid") continue;
    const payload = JSON.parse(v.payloadJson) as CartPricingPayloadV2;
    const recomputed = digestOfConfigJson(v.configJson);
    assert.ok(recomputed.ok, v.name);
    if (recomputed.ok) assert.equal(recomputed.digest, payload.configDigest, v.name);
  }
});

test("golden vectors: canonicalizing each parseable payload yields the fixture canonical string", () => {
  for (const v of VECTORS.vectors) {
    if (v.canonical === "") continue;
    let payload: CartPricingPayloadV2;
    try {
      payload = JSON.parse(v.payloadJson) as CartPricingPayloadV2;
    } catch {
      continue;
    }
    assert.equal(canonicalizeCartPricingPayloadV2(payload), v.canonical, v.name);
  }
});

// ---------------------------------------------------------------------------
// v2 signing + fail-closed policy provider
// ---------------------------------------------------------------------------

test("buildCartPricingPayloadV2 derives lineTotalCents from the components and binds every revision field", () => {
  const result = {
    quantity: 100,
    base: { netUnitPriceCents: 137 },
    decoration: null,
    options: { chargesCents: 0, selections: [] },
    production: { code: "STANDARD", feeCents: null },
    packaging: null,
    productColor: null,
  } as unknown as Parameters<typeof buildCartPricingPayloadV2>[0]["result"];

  const payload = buildCartPricingPayloadV2({
    result,
    currency: "USD",
    variantGid: "gid://shopify/ProductVariant/2",
    productGid: "gid://shopify/Product/1",
    enforcement: {
      installBinding: "inst",
      adjustmentVariantGid: "gid://shopify/ProductVariant/999",
      policyRevision: 7,
      profileRef: "prof_LNY01",
      profileRevision: 12,
    },
    normalizedConfigJson: "{}",
    configDigest: "sha256:abc",
    quoteId: "q-fixed",
    now: 123,
  });

  assert.equal(payload.v, 2);
  assert.equal(payload.lineTotalCents, 137 * 100);
  assert.equal(payload.profileRevision, 12);
  assert.equal(payload.policyRevision, 7);
  assert.equal(payload.installBinding, "inst");
  assert.equal(payload.issuedAtServer, 123);
});

test("signCartPricingPayloadV2 emits version 2 and carries the config JSON verbatim", () => {
  const payload = samplePayload();
  const signed = signCartPricingPayloadV2(payload, '{"a":1}', "secret");
  assert.equal(signed.version, 2);
  assert.equal(signed.config, '{"a":1}');
  assert.equal(signed.signature, signHex("secret", canonicalizeCartPricingPayloadV2(payload)));
  assert.deepEqual(JSON.parse(signed.payload), payload);
});

test("nullCartPricingPolicyProvider always fails closed with `block` — never bypass, never enforce", async () => {
  const decision = await nullCartPricingPolicyProvider.resolve({
    shopDomain: "x.myshopify.com",
    shopifyProductId: "1",
  });
  assert.deepEqual(decision, { action: "block", reason: "configuration_unavailable" });
});

test("quoteId is unpredictable — 200 generated ids are all distinct", () => {
  const ids = new Set<string>();
  const result = {
    quantity: 1,
    base: { netUnitPriceCents: 1 },
    decoration: null,
    options: { chargesCents: 0, selections: [] },
    production: { code: "S", feeCents: null },
    packaging: null,
    productColor: null,
  } as unknown as Parameters<typeof buildCartPricingPayloadV2>[0]["result"];
  for (let i = 0; i < 200; i++) {
    ids.add(
      buildCartPricingPayloadV2({
        result,
        currency: "USD",
        variantGid: "gid://shopify/ProductVariant/2",
        productGid: "gid://shopify/Product/1",
        enforcement: { installBinding: "i", adjustmentVariantGid: "gid://shopify/ProductVariant/9", policyRevision: 1, profileRef: "r", profileRevision: 1 },
        normalizedConfigJson: "{}",
        configDigest: "sha256:x",
      }).quoteId,
    );
  }
  assert.equal(ids.size, 200);
});
