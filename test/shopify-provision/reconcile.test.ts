/**
 * Task 5B.3B.2 — the PURE reconciliation / planning / gate logic of the phased
 * provisioner (`scripts/shopify/reconcile.mjs`). No IO, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADJ_PRODUCT_TAGS,
  ADJ_PRODUCT_TITLE,
} from "../../scripts/shopify/constants.mjs";
import {
  describeAdjustmentProduct,
  currencyReadiness,
  collectBlockers,
  planPrepare,
  planActivate,
  planEnablePilot,
  prepareComplete,
  canActivate,
  canEnablePilot,
  fingerprintBlockers,
  goNoGo,
  buildRollbackPlan,
  sessionLeaseMinutes,
  leaseBlockers,
} from "../../scripts/shopify/reconcile.mjs";

const TRANSFORM_FN = "gid://shopify/ShopifyFunction/tf-1";
const VALIDATION_FN = "gid://shopify/ShopifyFunction/vf-1";
const ADJ_VARIANT = "gid://shopify/ProductVariant/2";
const ADJ_PRODUCT = "gid://shopify/Product/1";

function okAdjProduct(over: Record<string, unknown> = {}, variantOver: Record<string, unknown> = {}) {
  return [
    {
      id: ADJ_PRODUCT,
      title: ADJ_PRODUCT_TITLE,
      status: "ACTIVE",
      onlineStoreUrl: null,
      tags: [...ADJ_PRODUCT_TAGS],
      variants: [
        {
          id: ADJ_VARIANT,
          price: "0.01",
          inventoryPolicy: "CONTINUE",
          taxable: false,
          inventoryItem: { tracked: false, requiresShipping: false },
          ...variantOver,
        },
      ],
      ...over,
    },
  ];
}

const GOOD_SHOP_POLICY = {
  schema: 1,
  mode: "pilot",
  enabled: false,
  adjustmentVariantGid: ADJ_VARIANT,
  installBinding: "dev-imprintid-pricing-development-pilot-1",
  policyRevision: 1,
};
const GOOD_PRODUCT_POLICY = {
  schema: 1,
  required: true,
  active: true,
  profileRef: "cmtb2ffnz0002q1mw7d2hol5k",
  profileRevision: 1,
  policyRevision: 1,
};

function baseState(over: Record<string, unknown> = {}) {
  return {
    shopId: "gid://shopify/Shop/1",
    shopName: "ImprintID Pricing Development",
    shopCurrency: "USD",
    profileCurrency: "USD",
    app: { title: "ImprintID Dynamic Pricing", apiKey: "d0d1f8d2c664325e5472f15b4fae3ac4" },
    receipt: null,
    shopPolicyJson: null,
    lny01PolicyJson: null,
    shopPolicyDefinitionId: null,
    productPolicyDefinitionId: null,
    functions: [
      { id: TRANSFORM_FN, title: "ImprintID Cart Pricing", apiType: "cart_transform", app: "ImprintID Dynamic Pricing" },
      { id: VALIDATION_FN, title: "imprintid-cart-validation", apiType: "cart_checkout_validation", app: "ImprintID Dynamic Pricing" },
    ],
    cartTransforms: [],
    validations: [],
    adjustmentProductMatches: [],
    ...over,
  };
}

const MATCHING_FP = { appServer: "abcd1234", transform: "abcd1234", validation: "abcd1234" };
const EMPTY_FP = { appServer: "00000000", transform: "00000000", validation: "00000000" };

// --- mutation-phase session lease guard (Task 5B.3B.3) -----------------------------

test("sessionLeaseMinutes: minutes until expiry; null / malformed → null", () => {
  const now = new Date("2026-09-02T18:00:00.000Z").getTime();
  assert.equal(sessionLeaseMinutes("2026-09-02T18:20:00.000Z", now), 20);
  assert.equal(sessionLeaseMinutes(new Date("2026-09-02T17:45:00.000Z"), now), -15);
  assert.equal(sessionLeaseMinutes(null, now), null);
  assert.equal(sessionLeaseMinutes(undefined, now), null);
  assert.equal(sessionLeaseMinutes("not-a-date", now), null);
});

test("leaseBlockers: --check / --rollback-check are NEVER gated", () => {
  assert.deepEqual(leaseBlockers(null, "check"), []);
  assert.deepEqual(leaseBlockers("2026-01-01T00:00:00.000Z", "rollback-check", new Date("2030-01-01").getTime()), []);
});

test("leaseBlockers: a mutating phase is BLOCKED under 15 min, on an expired token, and on an unknown expiry; allowed at >= 15 min", () => {
  const now = new Date("2026-09-02T18:00:00.000Z").getTime();
  for (const phase of ["prepare", "activate", "enable-pilot"]) {
    // 14 min left -> blocked
    assert.ok(leaseBlockers("2026-09-02T18:14:00.000Z", phase, now).some((b) => /at least 15/.test(b)), phase);
    // already expired -> blocked
    assert.ok(leaseBlockers("2026-09-02T17:30:00.000Z", phase, now).length > 0, phase);
    // no recorded expiry -> blocked (cannot confirm)
    assert.ok(leaseBlockers(null, phase, now).some((b) => /cannot confirm/.test(b)), phase);
    // 16 min left -> allowed
    assert.deepEqual(leaseBlockers("2026-09-02T18:16:00.000Z", phase, now), [], phase);
    // exactly 15 min -> allowed
    assert.deepEqual(leaseBlockers("2026-09-02T18:15:00.000Z", phase, now), [], phase);
  }
});

// --- adjustment product ------------------------------------------------------------

test("describeAdjustmentProduct: absent when there is no matching product", () => {
  assert.equal(describeAdjustmentProduct([]).status, "absent");
});

test("describeAdjustmentProduct: ok when every owned field already matches", () => {
  const d = describeAdjustmentProduct(okAdjProduct());
  assert.equal(d.status, "ok");
  assert.deepEqual(d.drift, []);
  assert.equal(d.variantId, ADJ_VARIANT);
});

test("describeAdjustmentProduct: partial state is REPAIRABLE with a minimal in-place plan", () => {
  const d = describeAdjustmentProduct(okAdjProduct({ status: "DRAFT" }, { price: "9.99", taxable: true }));
  assert.equal(d.status, "repairable");
  assert.ok(d.drift.some((x: string) => /status is DRAFT/.test(x)));
  assert.ok(d.drift.some((x: string) => /price is 9.99/.test(x)));
  assert.deepEqual(d.productUpdate, { id: ADJ_PRODUCT, status: "ACTIVE" });
  assert.deepEqual(d.variantUpdate, { id: ADJ_VARIANT, price: "0.01", taxable: false });
});

test("describeAdjustmentProduct: tracked inventory / requiresShipping drift is repairable", () => {
  const d = describeAdjustmentProduct(okAdjProduct({}, { inventoryItem: { tracked: true, requiresShipping: true } }));
  assert.equal(d.status, "repairable");
  const vu = d.variantUpdate as { id: string; inventoryItem?: { tracked: boolean; requiresShipping: boolean } };
  assert.deepEqual(vu.inventoryItem, { tracked: false, requiresShipping: false });
});

test("describeAdjustmentProduct: AMBIGUOUS (never auto-repaired) on >1 match, ≠1 variant, or Online-Store publication", () => {
  assert.equal(describeAdjustmentProduct([...okAdjProduct(), ...okAdjProduct({ id: "gid://shopify/Product/9" })]).status, "ambiguous");
  assert.equal(describeAdjustmentProduct(okAdjProduct({ variants: [] })).status, "ambiguous");
  assert.equal(
    describeAdjustmentProduct(okAdjProduct({ onlineStoreUrl: "https://x.example/products/adj" })).status,
    "ambiguous",
  );
});

// --- foreign resources -> blockers ------------------------------------------------

test("collectBlockers: a foreign Cart Transform or Validation is a hard blocker", () => {
  const s = baseState({
    cartTransforms: [{ id: "gid://shopify/CartTransform/FOREIGN", functionId: "other-fn", blockOnFailure: true }],
    validations: [{ id: "gid://shopify/Validation/FOREIGN", title: "Someone else's validation", enabled: true, blockOnFailure: true }],
  });
  const b = collectBlockers(s);
  assert.ok(b.some((x) => /unrelated Cart Transform/.test(x)));
  assert.ok(b.some((x) => /unrelated Validation/.test(x)));
});

test("collectBlockers: our own resources are NOT blockers", () => {
  const s = baseState({
    cartTransforms: [{ id: "gid://shopify/CartTransform/OURS", functionId: TRANSFORM_FN, blockOnFailure: true }],
    validations: [{ id: "gid://shopify/Validation/OURS", title: "ImprintID Dynamic Pricing Validation", enabled: true, blockOnFailure: true }],
  });
  assert.deepEqual(collectBlockers(s), []);
});

// --- currency -------------------------------------------------------------------

test("currencyReadiness: USD profile + USD shop is enforceable; USD + BDT is not", () => {
  assert.equal(currencyReadiness(baseState()).enforceable, true);
  const bdt = currencyReadiness(baseState({ shopCurrency: "BDT" }));
  assert.equal(bdt.enforceable, false);
  assert.equal(bdt.reason, "PROFILE_SHOP_CURRENCY_MISMATCH");
});

// --- phase plans --------------------------------------------------------------------

test("planPrepare: on an empty store, plans product+variant, .env, both definitions, and metafieldsSet (enabled FALSE)", () => {
  const plan = planPrepare(baseState());
  const ops = plan.steps.map((s) => s.op);
  assert.ok(ops.includes("productCreate"));
  assert.ok(ops.includes("productVariantsBulkUpdate"));
  assert.ok(ops.includes("metafieldDefinitionCreate"));
  assert.ok(ops.includes("metafieldsSet"));
  assert.ok(plan.steps.some((s) => /enabled: FALSE/i.test(s.detail)));
  assert.ok(!ops.includes("cartTransformCreate"), "prepare NEVER plans the Cart Transform");
  assert.ok(!ops.includes("validationCreate"), "prepare NEVER plans an active Validation");
});

test("planPrepare: a fully-converged store plans only idempotent no-ops", () => {
  const converged = baseState({
    adjustmentProductMatches: okAdjProduct(),
    shopPolicyDefinitionId: "gid://shopify/MetafieldDefinition/1",
    productPolicyDefinitionId: "gid://shopify/MetafieldDefinition/2",
    shopPolicyJson: GOOD_SHOP_POLICY,
    lny01PolicyJson: GOOD_PRODUCT_POLICY,
  });
  const plan = planPrepare(converged);
  const mutating = plan.steps.filter((s) => !["(none)", "(local) .env", "metafieldsSet"].includes(s.op));
  assert.deepEqual(mutating, [], "nothing new to create when already converged");
});

test("planActivate: plans exactly one Cart Transform + one Validation on an activated-but-empty store", () => {
  const plan = planActivate(baseState());
  assert.deepEqual(plan.steps.map((s) => s.op), ["cartTransformCreate", "validationCreate"]);
});

test("planEnablePilot: the only mutation is metafieldsSet, and it is pilot-scoped, never universal", () => {
  const plan = planEnablePilot(baseState({ adjustmentProductMatches: okAdjProduct() }));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].op, "metafieldsSet");
  assert.ok(/pilot/i.test(plan.steps[0].detail));
  assert.ok(/NEVER universal/i.test(plan.steps[0].detail));
});

// --- phase gates: no phase may silently perform a later phase ----------------------

test("prepareComplete: false without a receipt; false when enforcement is already enabled", () => {
  assert.equal(prepareComplete(baseState()).ok, false);
  const preparedButEnabled = baseState({
    receipt: { phaseReached: "prepared" },
    adjustmentProductMatches: okAdjProduct(),
    shopPolicyDefinitionId: "d1",
    productPolicyDefinitionId: "d2",
    shopPolicyJson: { ...GOOD_SHOP_POLICY, enabled: true },
    lny01PolicyJson: GOOD_PRODUCT_POLICY,
  });
  const r = prepareComplete(preparedButEnabled);
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => /already enabled/.test(b)));
});

function preparedState(over: Record<string, unknown> = {}) {
  return baseState({
    receipt: { phaseReached: "prepared", resources: { adjustmentVariantId: ADJ_VARIANT } },
    adjustmentProductMatches: okAdjProduct(),
    shopPolicyDefinitionId: "d1",
    productPolicyDefinitionId: "d2",
    shopPolicyJson: GOOD_SHOP_POLICY,
    lny01PolicyJson: GOOD_PRODUCT_POLICY,
    ...over,
  });
}

test("canActivate: BLOCKED until the signing-secret fingerprints match (activate cannot run before fingerprint verification)", () => {
  assert.equal(canActivate(preparedState(), EMPTY_FP).ok, false);
  assert.ok(canActivate(preparedState(), EMPTY_FP).blockers.some((b) => /fn:config/.test(b)));

  const mismatch = { appServer: "aaaaaaaa", transform: "bbbbbbbb", validation: "aaaaaaaa" };
  const r = canActivate(preparedState(), mismatch);
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => /fingerprint mismatch/.test(b)));

  assert.equal(canActivate(preparedState(), MATCHING_FP).ok, true);
});

test("canActivate: BLOCKED without prepared-state evidence even with matching fingerprints (prepare cannot be skipped)", () => {
  const r = canActivate(baseState(), MATCHING_FP);
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => /--prepare/.test(b)));
});

test("fingerprintBlockers: all-empty, partial, and mismatched fingerprints each block; a matching non-empty triple passes", () => {
  assert.ok(fingerprintBlockers(EMPTY_FP).length > 0);
  assert.ok(fingerprintBlockers({ appServer: "abcd1234", transform: "00000000", validation: "abcd1234" }).length > 0);
  assert.ok(fingerprintBlockers({ appServer: "abcd1234", transform: "abcd1234", validation: "ffff0000" }).length > 0);
  assert.deepEqual(fingerprintBlockers(MATCHING_FP), []);
});

test("canEnablePilot: BLOCKED until BOTH activated resources read back correctly (pilot cannot enable before activation)", () => {
  // prepared only, no transform/validation
  assert.equal(canEnablePilot(preparedState()).ok, false);

  // activated receipt but validation not enabled
  const halfActivated = preparedState({
    receipt: { phaseReached: "activated", resources: {} },
    cartTransforms: [{ id: "ct1", functionId: TRANSFORM_FN, blockOnFailure: true }],
    validations: [{ id: "v1", title: "ImprintID Dynamic Pricing Validation", enabled: false, blockOnFailure: true }],
  });
  const r = canEnablePilot(halfActivated);
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => /Validation is not enabled/.test(b)));

  // fully activated
  const activated = preparedState({
    receipt: { phaseReached: "activated", resources: {} },
    cartTransforms: [{ id: "ct1", functionId: TRANSFORM_FN, blockOnFailure: true }],
    validations: [{ id: "v1", title: "ImprintID Dynamic Pricing Validation", enabled: true, blockOnFailure: true }],
  });
  assert.equal(canEnablePilot(activated).ok, true);
});

// --- GO/NO-GO summary --------------------------------------------------------------

test("goNoGo: rollback-check is always GO; enable-pilot is NO-GO on a currency mismatch", () => {
  const g = goNoGo(baseState({ shopCurrency: "BDT" }), MATCHING_FP);
  assert.equal(g["rollback-check"].go, true);
  assert.equal(g["enable-pilot"].go, false);
  assert.ok(g["enable-pilot"].blockers.some((b: string) => /currency not enforceable/.test(b)));
});

// --- rollback plan ---------------------------------------------------------------

test("buildRollbackPlan: references ONLY receipt-recorded ids, in reverse order, and executes nothing", () => {
  const receipt = {
    phaseReached: "pilot-enabled",
    resources: {
      adjustmentProductId: ADJ_PRODUCT,
      shopPolicyDefinitionId: "def-shop",
      productPolicyDefinitionId: "def-prod",
      cartTransformId: "gid://shopify/CartTransform/OURS",
      validationId: "gid://shopify/Validation/OURS",
    },
  };
  const plan = buildRollbackPlan(receipt, baseState());
  assert.equal(plan.executed, false);
  const muts = plan.steps.map((s) => s.mutation);
  // disable pilot first, then delete validation, then transform, then metafields, defs, product
  assert.deepEqual(muts.slice(0, 3), ["metafieldsSet", "validationDelete", "cartTransformDelete"]);
  assert.ok(plan.steps.every((s) => !/gid:\/\/shopify\/(CartTransform|Validation)\/(?!OURS)/.test(s.detail)));
});

test("buildRollbackPlan: a present-but-unrecorded resource is listed as NOT touched", () => {
  const receipt = { phaseReached: "prepared", resources: { adjustmentProductId: ADJ_PRODUCT } };
  const state = baseState({
    cartTransforms: [{ id: "gid://shopify/CartTransform/STRANGER", functionId: TRANSFORM_FN, blockOnFailure: true }],
  });
  const plan = buildRollbackPlan(receipt, state);
  assert.ok(plan.notTouched.some((n) => /STRANGER/.test(n)));
});
