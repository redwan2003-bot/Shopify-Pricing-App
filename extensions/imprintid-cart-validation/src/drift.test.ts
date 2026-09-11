import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canonicalizeCartPricingPayloadV2, type CartPricingPayloadV2 } from "./cart-pricing-contract.ts";
import { signHex } from "./hmac-sha256.ts";
import { normalizeConfig } from "./config-normalization.ts";
import {
  verifyCartPricingAttributesV2,
  type ShopEnforcementPolicy,
  type ProductPricingPolicy,
} from "./verify-payload-v2.ts";
import { expectedExpandedComponents } from "./expanded-components.ts";

// The Transform's real logic — cross-checked here (test only; not part of the Function bundle).
import { runCartTransform } from "../../imprintid-cart-pricing/src/cart_transform_run.ts";
import type { NormalizedTransformInput } from "../../imprintid-cart-pricing/src/cart_transform_run.ts";

const VECTORS = JSON.parse(
  readFileSync(new URL("../../../test/fixtures/signed-quote-vectors-v2.json", import.meta.url), "utf8"),
) as {
  secret: string;
  vectors: Array<{
    name: string;
    payloadJson: string;
    configJson: string;
    signature: string;
    canonical: string;
    line: { quantity: number; variantGid: string | null; productGid: string | null; currencyCode: string | null };
    shopPolicy: ShopEnforcementPolicy;
    productPolicy: ProductPricingPolicy;
    expect: string;
  }>;
};

// ---------------------------------------------------------------------------
// 1. Application signer ↔ Validation verifier — identical canonical + signature
// ---------------------------------------------------------------------------

test("drift: the Validation extension canonicalizes + signs every golden vector identically to the fixture", () => {
  for (const v of VECTORS.vectors) {
    if (v.canonical === "" || v.name === "unknown-extra-field" || v.name === "missing-required-field") continue;
    const payload = JSON.parse(v.payloadJson) as CartPricingPayloadV2;
    assert.equal(canonicalizeCartPricingPayloadV2(payload), v.canonical, `${v.name}: canonical`);
    if (v.expect !== "bad_signature") {
      assert.equal(signHex(VECTORS.secret, v.canonical), v.signature, `${v.name}: signature`);
    }
  }
});

test("drift: the Validation config digest matches the signed configDigest for every valid vector", () => {
  for (const v of VECTORS.vectors) {
    if (v.expect !== "valid") continue;
    const payload = JSON.parse(v.payloadJson) as CartPricingPayloadV2;
    const n = normalizeConfig(JSON.parse(v.configJson));
    assert.ok(n.ok, v.name);
    if (n.ok) assert.equal(n.digest, payload.configDigest, v.name);
  }
});

// ---------------------------------------------------------------------------
// 2. Validation verifier ↔ Transform verifier — identical accept/reject decision
// ---------------------------------------------------------------------------

test("drift: verifyCartPricingAttributesV2 in the Validation extension matches every vector's `expect`", () => {
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

// ---------------------------------------------------------------------------
// 3. expectedExpandedComponents ↔ the Transform's real lineExpand output
// ---------------------------------------------------------------------------

function txInputForValidVector(v: (typeof VECTORS.vectors)[number]): NormalizedTransformInput {
  const p = JSON.parse(v.payloadJson) as CartPricingPayloadV2;
  return {
    presentmentRate: "1",
    shopPolicyJson: { ...v.shopPolicy, mode: "pilot", allowLegacyV1: false },
    lines: [
      {
        id: "gid://shopify/CartLine/1",
        quantity: p.quantity,
        merchandiseId: p.variantGid,
        productGid: p.productGid,
        productPolicyJson: v.productPolicy,
        currencyCode: p.currency,
        attrs: { version: "2", payload: v.payloadJson, signature: v.signature, config: v.configJson },
      },
    ],
  };
}

test("drift: expectedExpandedComponents equals the Transform's actual expanded items for every valid vector", () => {
  for (const v of VECTORS.vectors) {
    if (v.expect !== "valid") continue;
    const p = JSON.parse(v.payloadJson) as CartPricingPayloadV2;
    const result = runCartTransform(txInputForValidVector(v), VECTORS.secret);
    assert.equal(result.operations.length, 1, `${v.name}: transform should expand`);
    const op = result.operations[0]!;
    assert.ok("lineExpand" in op && op.lineExpand, v.name);
    if (!("lineExpand" in op) || !op.lineExpand) continue;

    const actual = op.lineExpand.expandedCartItems.map((i) => ({
      merchandiseGid: i.merchandiseId,
      quantity: i.quantity,
      amount: i.price!.adjustment.fixedPricePerUnit.amount,
    }));
    const expected = expectedExpandedComponents(p).map((c) => ({
      merchandiseGid: c.merchandiseGid,
      quantity: c.quantity,
      amount: `${Math.floor(c.perUnitCents / 100)}.${String(c.perUnitCents % 100).padStart(2, "0")}`,
    }));
    assert.deepEqual(actual, expected, `${v.name}: component multiset`);
  }
});
