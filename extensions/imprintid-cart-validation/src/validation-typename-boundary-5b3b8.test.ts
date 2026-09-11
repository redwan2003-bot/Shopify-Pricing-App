/**
 * Task 5B.3B.8 — Validation-side boundary for the Cart Transform `__typename` fix.
 *
 * The Transform defect (its input query omitted `merchandise.__typename`) is fixed in
 * the `imprintid-cart-pricing` extension. These tests assert:
 *   - the Validation's OWN input query already requests every discriminator it uses
 *     (`merchIsVariant` gates on `m.__typename === "ProductVariant"`), so no parallel
 *     fix is needed here;
 *   - the Validation still BLOCKS a required-price line whenever it cannot confirm safe
 *     enforcement (which includes the window where the Transform can't enforce);
 *   - the Validation stays a strict no-op while enforcement is disabled — it was never
 *     weakened to paper over the Transform bug.
 *
 * Synthetic Shopify ids + a deterministic test secret only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runValidation, cartValidationsGenerateRun } from "./cart_validations_generate_run.ts";
import type { NormalizedValidationInput, NormalizedValidationLine } from "./normalize-input.ts";

const SECRET = "task-5b3b8-validation-deterministic-secret";
const ADJ = "gid://shopify/ProductVariant/900000001";
const PRODUCT = "gid://shopify/Product/800000002";
const VARIANT = "gid://shopify/ProductVariant/800000003";

const SHOP = (mode: string, over: Record<string, unknown> = {}) => ({
  schema: 1,
  mode,
  enabled: true,
  allowLegacyV1: false,
  adjustmentVariantGid: ADJ,
  installBinding: "test-install-5b3b8",
  policyRevision: 5,
  ...over,
});
const REQUIRED_PRODUCT_POLICY = { schema: 1, required: true, active: true, profileRef: "prof_TEST", profileRevision: 9, policyRevision: 5 };

function line(over: Partial<NormalizedValidationLine> = {}): NormalizedValidationLine {
  return {
    id: "gid://shopify/CartLine/00000000-0000-4000-8000-000000000002",
    quantity: 100,
    isProductVariant: true,
    variantGid: VARIANT,
    productGid: PRODUCT,
    productPolicyJson: REQUIRED_PRODUCT_POLICY,
    hasSellingPlan: false,
    attrs: { version: null, payload: null, signature: null, config: null },
    money: { amountPerQuantityCents: 137, subtotalCents: 13700, currency: "USD" },
    parentLineId: null,
    ...over,
  };
}
const input = (lines: NormalizedValidationLine[], shopPolicyJson: unknown, buyerStep = "CART_INTERACTION"): NormalizedValidationInput => ({
  buyerStep,
  shopPolicyJson,
  lines,
});

// --- audit: the Validation query already requests merchandise.__typename ------------

test("audit: cart_validations_generate_run.graphql requests `merchandise.__typename` (discriminator it relies on)", () => {
  const gql = readFileSync(fileURLToPath(new URL("./cart_validations_generate_run.graphql", import.meta.url)), "utf8");
  const merchBlock = gql.slice(gql.indexOf("merchandise {"), gql.indexOf("... on ProductVariant"));
  assert.match(merchBlock, /__typename/);

  const norm = readFileSync(fileURLToPath(new URL("./normalize-input.ts", import.meta.url)), "utf8");
  assert.match(norm, /__typename === "ProductVariant"/, "merchIsVariant gates on the queried discriminator");
});

// --- 10. Validation blocks a required-price line when the Transform cannot enforce ---

test("10. an enabled pilot required-price line is BLOCKED by Validation (targets $.cart) while safe enforcement is unconfirmed", () => {
  const errs = runValidation(input([line()], SHOP("pilot")), SECRET);
  assert.ok(errs.length >= 1, "a required line with no confirmed enforcement must be blocked");
  const exported = cartValidationsGenerateRun({
    buyerJourney: { step: "CART_INTERACTION" },
    shop: { enforcementPolicy: { jsonValue: SHOP("pilot") } },
    cart: {
      lines: [
        {
          id: VARIANT,
          quantity: 100,
          cost: { amountPerQuantity: { amount: "1.37" }, subtotalAmount: { amount: "137.00", currencyCode: "USD" } },
          sellingPlanAllocation: null,
          merchandise: { __typename: "ProductVariant", id: VARIANT, product: { id: PRODUCT, pricingPolicy: { jsonValue: REQUIRED_PRODUCT_POLICY } } },
          version: null,
          payload: null,
          signature: null,
          config: null,
          parentRelationship: null,
        },
      ],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const validationErrors = exported.operations[0]!.validationAdd!.errors;
  assert.ok(validationErrors.length >= 1, "exported path blocks");
  for (const e of validationErrors) assert.equal(e.target, "$.cart");
});

test("10b. universal mode also blocks a required-price line under the same condition", () => {
  assert.ok(runValidation(input([line()], SHOP("universal")), SECRET).length >= 1);
});

// --- 11. Validation remains a no-op while enforcement is disabled -------------------

test("11. disabled shop policy → Validation emits NO errors for an ordinary product line", () => {
  assert.deepEqual(runValidation(input([line()], SHOP("pilot", { enabled: false })), SECRET), []);
  assert.deepEqual(runValidation(input([line()], SHOP("disabled")), SECRET), []);
});

test("11b. disabled policy + an unmarked (no product policy) line → still NO errors", () => {
  assert.deepEqual(runValidation(input([line({ productPolicyJson: null })], SHOP("disabled")), SECRET), []);
});

// --- fixture hygiene --------------------------------------------------------------

test("fixture hygiene: synthetic ids, deterministic readable secret, no token / live domain / opaque random secret", () => {
  const src = readFileSync(fileURLToPath(new URL("./validation-typename-boundary-5b3b8.test.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(src, new RegExp("shp" + "at_"), "no Admin access token");
  assert.doesNotMatch(src, new RegExp("[.]my" + "shopify[.]com"), "no live shop domain");
  // no 24+ char opaque run with NO word separators (what a real random secret looks like)
  assert.doesNotMatch(src, /["'][A-Za-z0-9]{24,}["']/, "no opaque random-looking secret literal");
  // the test secret is a readable hyphen-delimited phrase, not random bytes
  assert.equal(SECRET, "task-5b3b8-validation-deterministic-secret");
  assert.match(SECRET, /^[a-z0-9-]+$/);
  assert.ok(SECRET.split("-").length >= 4, "readable phrase, not entropy");
  for (const gid of [ADJ, PRODUCT, VARIANT]) assert.match(gid, /\/(7|8|9)\d{8}$/);
});
