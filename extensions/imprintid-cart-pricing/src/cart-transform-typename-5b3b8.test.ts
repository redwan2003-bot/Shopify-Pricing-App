/**
 * Task 5B.3B.8 — regression: the Cart Transform must discriminate ProductVariant
 * merchandise via the GraphQL `__typename` field, and its input query must actually
 * request it.
 *
 * Production incident: `cart_transform_run.graphql` selected `merchandise { ... on
 * ProductVariant { ... } }` WITHOUT `__typename`, while `normalizeTransformInput` gates
 * on `merch.__typename === "ProductVariant"`. Real Shopify Function input logs confirmed
 * `__typename` was absent → every real ProductVariant line was normalized to a
 * non-variant (`merchandiseId`/`productGid`/`productPolicyJson` all `null`) → the
 * enforced-pricing path could never be reached when enforcement is enabled.
 *
 * These tests drive the RAW generated-input shape through `normalizeTransformInput` →
 * `runCartTransform`, using synthetic Shopify ids and a deterministic test secret. No
 * real signing secret, real signed cart properties, tokens, customer data, or live cart
 * identifiers appear in any fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runCartTransform, normalizeTransformInput } from "./cart_transform_run.ts";
import type { CartTransformRunInput } from "../generated/api.ts";
import { canonicalizeCartPricingPayloadV2 } from "./cart-pricing-contract.ts";
import { normalizeConfig } from "./config-normalization.ts";
import { signHex } from "./hmac-sha256.ts";

// --- deterministic synthetic fixtures --------------------------------------------------

const SECRET = "task-5b3b8-deterministic-test-secret";
const ADJ_VARIANT = "gid://shopify/ProductVariant/900000001";
const PRODUCT = "gid://shopify/Product/800000002";
const VARIANT = "gid://shopify/ProductVariant/800000003";
const INSTALL = "test-install-binding-5b3b8";
const CART_LINE = "gid://shopify/CartLine/00000000-0000-4000-8000-000000000001";

const SHOP_POLICY = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  mode: "pilot",
  enabled: true,
  adjustmentVariantGid: ADJ_VARIANT,
  installBinding: INSTALL,
  policyRevision: 5,
  ...over,
});
const PRODUCT_POLICY = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  required: true,
  active: true,
  profileRef: "prof_TEST_LNY",
  profileRevision: 9,
  policyRevision: 5,
  ...over,
});

/** A signed v2 quote for `quantity` units: base 137¢/unit + flat 4500¢ (matches the
 * existing hardening-test vector so the expected expansion is well known). */
function signedV2(over: Record<string, unknown> = {}) {
  const n = normalizeConfig({ quantity: 100, optionValueIds: ["a"], decorationMethod: "SCREEN_PRINT" });
  if (!n.ok) throw new Error("fixture config");
  const payload = {
    v: 2,
    installBinding: INSTALL,
    productGid: PRODUCT,
    variantGid: VARIANT,
    quantity: 100,
    currency: "USD",
    baseUnitPriceCents: 137,
    perUnitSurchargeCents: 0,
    flatSurchargeCents: 4500,
    lineTotalCents: 137 * 100 + 4500,
    adjustmentVariantGid: ADJ_VARIANT,
    profileRef: "prof_TEST_LNY",
    profileRevision: 9,
    policyRevision: 5,
    configDigest: n.digest,
    quoteId: "q-5b3b8-test",
    issuedAtServer: 1,
    ...over,
  };
  return {
    payload,
    configJson: n.canonicalJson,
    signature: signHex(SECRET, canonicalizeCartPricingPayloadV2(payload as never)),
  };
}

/** Builds the RAW `CartTransformRunInput` (generated shape) for one line. `merchandise`
 * is passed verbatim so a test can include/omit/alter `__typename`. */
function rawInput(opts: {
  merchandise: unknown;
  shopPolicyJson?: unknown;
  productPolicyJson?: unknown;
  quantity?: number;
  currencyCode?: string;
  quote?: { payload: unknown; configJson: string; signature: string } | null;
  presentmentCurrencyRate?: string;
}): CartTransformRunInput {
  const q = opts.quote;
  const merch = opts.merchandise as Record<string, unknown> | null;
  // graft the product policy onto the merchandise's product, when the shape has one
  if (merch && typeof merch === "object" && merch.product && typeof merch.product === "object" && "productPolicyJson" in opts) {
    (merch.product as Record<string, unknown>).pricingPolicy =
      opts.productPolicyJson == null ? null : { jsonValue: opts.productPolicyJson };
  }
  const attr = (v: string | null) => (v == null ? null : { value: v });
  return {
    presentmentCurrencyRate: opts.presentmentCurrencyRate ?? "1.0",
    shop: { enforcementPolicy: opts.shopPolicyJson == null ? null : { jsonValue: opts.shopPolicyJson } },
    cart: {
      lines: [
        {
          id: CART_LINE,
          quantity: opts.quantity ?? 100,
          cost: {
            amountPerQuantity: { amount: "1.37", currencyCode: opts.currencyCode ?? "USD" },
            totalAmount: { amount: "182.00", currencyCode: opts.currencyCode ?? "USD" },
          },
          merchandise: merch,
          version: attr(q ? "2" : null),
          payload: attr(q ? JSON.stringify(q.payload) : null),
          signature: attr(q ? q.signature : null),
          config: attr(q ? q.configJson : null),
        },
      ],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const productVariantMerch = (over: Record<string, unknown> = {}) => ({
  __typename: "ProductVariant",
  id: VARIANT,
  product: { id: PRODUCT, pricingPolicy: null },
  ...over,
});

const run = (input: CartTransformRunInput) => runCartTransform(normalizeTransformInput(input), SECRET);
const expandAmounts = (r: ReturnType<typeof run>) => {
  const op = r.operations[0];
  if (!op || !("lineExpand" in op) || !op.lineExpand) return null;
  return {
    cartLineId: op.lineExpand.cartLineId,
    items: op.lineExpand.expandedCartItems.map((i) => ({
      merchandiseId: i.merchandiseId,
      quantity: i.quantity,
      amount: i.price!.adjustment.fixedPricePerUnit.amount,
    })),
  };
};

// --- 1. the query requests merchandise.__typename ------------------------------------

test("1. cart_transform_run.graphql requests `merchandise.__typename`", () => {
  const gql = readFileSync(fileURLToPath(new URL("./cart_transform_run.graphql", import.meta.url)), "utf8");
  const merchBlock = gql.slice(gql.indexOf("merchandise {"), gql.indexOf("... on ProductVariant"));
  assert.match(merchBlock, /__typename/, "the `merchandise` selection set must include `__typename`");
});

// --- 2. generated type exposes the ProductVariant discriminator ---------------------

test("2. generated CartTransformRunInput types the merchandise union with a REQUIRED `__typename` discriminator", () => {
  const api = readFileSync(fileURLToPath(new URL("../generated/api.ts", import.meta.url)), "utf8");
  const line = api.split("\n").find((l) => /^export type CartTransformRunInput\s*=/.test(l));
  assert.ok(line, "generated CartTransformRunInput type present");
  assert.match(line!, /merchandise: \{ __typename: 'CustomProduct' \} \| \{ __typename: 'ProductVariant'/);
  assert.doesNotMatch(line!, /merchandise: \{ __typename\?: 'CustomProduct'/, "discriminator must not be optional");
});

// --- 3 & 4. valid ProductVariant with __typename reaches the enforced path + exact op

test("3+4. a valid `__typename: ProductVariant` line with a signed v2 quote is EXPANDED to the exact expected operation", () => {
  const r = run(
    rawInput({
      merchandise: productVariantMerch(),
      shopPolicyJson: SHOP_POLICY(),
      productPolicyJson: PRODUCT_POLICY(),
      quote: signedV2(),
    }),
  );
  assert.equal(r.operations.length, 1, "enforced path reached → exactly one lineExpand");
  assert.deepEqual(expandAmounts(r), {
    cartLineId: CART_LINE,
    items: [
      { merchandiseId: VARIANT, quantity: 1, amount: "1.37" }, // base 137¢ per bundle unit
      { merchandiseId: ADJ_VARIANT, quantity: 1, amount: "0.45000000" }, // 4500¢ spread across 100 units
    ],
  });
});

// --- 5. no __typename → fails closed -----------------------------------------------

test("5. a ProductVariant-shaped line WITHOUT `__typename` fails closed — NO operation, even with policy enabled + a valid quote", () => {
  const merchNoTypename = { id: VARIANT, product: { id: PRODUCT, pricingPolicy: null } };
  const r = run(
    rawInput({
      merchandise: merchNoTypename,
      shopPolicyJson: SHOP_POLICY(),
      productPolicyJson: PRODUCT_POLICY(),
      quote: signedV2(),
    }),
  );
  assert.deepEqual(r.operations, [], "Shopify omitting the discriminator must never be inferred as a variant");

  // and normalization itself must have produced nulls, not guessed identity
  const norm = normalizeTransformInput(
    rawInput({ merchandise: merchNoTypename, shopPolicyJson: SHOP_POLICY(), productPolicyJson: PRODUCT_POLICY() }),
  );
  assert.equal(norm.lines[0]!.merchandiseId, null);
  assert.equal(norm.lines[0]!.productGid, null);
  assert.equal(norm.lines[0]!.productPolicyJson, null);
});

// --- 6. unknown / non-ProductVariant typename → no operation -----------------------

test("6. an unknown or non-ProductVariant `__typename` produces NO operation", () => {
  for (const bad of ["CustomProduct", "GiftCard", "SomethingNew", ""]) {
    const r = run(
      rawInput({
        merchandise: { __typename: bad, id: VARIANT, product: { id: PRODUCT, pricingPolicy: null } },
        shopPolicyJson: SHOP_POLICY(),
        productPolicyJson: PRODUCT_POLICY(),
        quote: signedV2(),
      }),
    );
    assert.deepEqual(r.operations, [], `__typename=${JSON.stringify(bad)}`);
  }
});

// --- 7. mismatched product id → fail closed ---------------------------------------

test("7. a ProductVariant whose line product id disagrees with the signed quote fails closed (product_mismatch)", () => {
  const r = run(
    rawInput({
      merchandise: productVariantMerch({ product: { id: "gid://shopify/Product/799999999", pricingPolicy: null } }),
      shopPolicyJson: SHOP_POLICY(),
      productPolicyJson: PRODUCT_POLICY(),
      quote: signedV2(), // quote.productGid = PRODUCT (800000002)
    }),
  );
  assert.deepEqual(r.operations, []);
});

// --- 8. mismatched variant id → fail closed --------------------------------------

test("8. a ProductVariant whose line variant id disagrees with the signed quote fails closed (variant_mismatch)", () => {
  const r = run(
    rawInput({
      merchandise: productVariantMerch({ id: "gid://shopify/ProductVariant/799999998" }),
      shopPolicyJson: SHOP_POLICY(),
      productPolicyJson: PRODUCT_POLICY(),
      quote: signedV2(), // quote.variantGid = VARIANT (800000003)
    }),
  );
  assert.deepEqual(r.operations, []);
});

// --- 9. disabled policy still no-ops ---------------------------------------------

test("9. disabled shop policy still produces `operations: []` even for a valid `__typename: ProductVariant` + signed quote", () => {
  const r = run(
    rawInput({
      merchandise: productVariantMerch(),
      shopPolicyJson: SHOP_POLICY({ enabled: false }),
      productPolicyJson: PRODUCT_POLICY(),
      quote: signedV2(),
    }),
  );
  assert.deepEqual(r.operations, []);
});

// --- 12. fixture hygiene --------------------------------------------------------

test("12. all fixtures are synthetic — no access token, no live shop domain, no long opaque secret, deterministic test secret only", () => {
  const src = readFileSync(fileURLToPath(new URL("./cart-transform-typename-5b3b8.test.ts", import.meta.url)), "utf8");
  // patterns assembled from parts so the literal never appears in this file
  assert.doesNotMatch(src, new RegExp("shp" + "at_"), "no Admin access token");
  assert.doesNotMatch(src, new RegExp("[.]my" + "shopify[.]com"), "no live shop domain");
  // no 24+ char opaque run with no word separators (what a real random secret looks like)
  assert.doesNotMatch(src, /["'][A-Za-z0-9]{24,}["']/, "no opaque random-looking secret literal");
  assert.equal(SECRET, "task-5b3b8-deterministic-test-secret", "the test secret is a readable phrase, not entropy");
  assert.ok(SECRET.split("-").length >= 4);
  // every synthetic Shopify id is a 9-digit value starting 7/8/9 — not a real store's id
  for (const gid of [ADJ_VARIANT, PRODUCT, VARIANT]) assert.match(gid, /\/(7|8|9)\d{8}$/);
  // the cart-line id is a fixed synthetic UUID, not a live one
  assert.match(CART_LINE, /\/0{8}-0000-4000-8000-0{11}1$/);
});
