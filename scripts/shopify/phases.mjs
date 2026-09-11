/**
 * Task 5B.3B.2 — the five provisioning phases. Each does STRICTLY its own step and
 * STOPS; no phase silently performs a later one.
 *
 *   check         — read-only. Full report; never mutates, never exits early.
 *   prepare       — adjustment product/variant + .env secret + definitions + policy
 *                   values (enforcement DISABLED). Never the Cart Transform / active Validation.
 *   activate      — ONE Cart Transform + ONE Validation, both blockOnFailure. Requires
 *                   prepared-state evidence + matching secret fingerprints. Enforcement stays off.
 *   enable-pilot  — flip shop enforcement_policy.enabled → true (pilot; LNY01 only; never
 *                   universal). Requires both activated resources to read back correctly.
 *   rollback-check — print an exact rollback plan for the current receipt. Executes nothing.
 *
 * Dependencies are injected (`gql`, `io`) so the orchestration is unit-testable with a
 * fake Admin client and no filesystem.
 */

import {
  ADJ_PRODUCT_DESCRIPTION_HTML,
  ADJ_PRODUCT_TAGS,
  ADJ_PRODUCT_TITLE,
  ADJ_PRODUCT_TYPE,
  ADJ_PRODUCT_VENDOR,
  ADJ_VARIANT_DESIRED,
  APP_NS,
  LNY01_PRODUCT_GID,
  PRODUCT_POLICY_KEY,
  SCRIPT_VERSION,
  SHOP_POLICY_KEY,
  TRANSFORM_HANDLE,
  VALIDATION_HANDLE,
  VALIDATION_TITLE,
  productPolicyValue,
  shopPolicyValue,
} from "./constants.mjs";
import {
  buildRollbackPlan,
  canActivate,
  canEnablePilot,
  currencyReadiness,
  describeAdjustmentProduct,
  describeCartTransforms,
  describeFunctions,
  describePolicies,
  describeValidations,
  goNoGo,
  planActivate,
  planEnablePilot,
  planPrepare,
  sessionLeaseMinutes,
} from "./reconcile.mjs";
import { MUTATION_LEASE_MINUTES } from "./constants.mjs";

class StopError extends Error {}
const stop = (msg) => {
  throw new StopError(msg);
};

function assertNoUserErrors(io, payload, label) {
  const e = io.userErrors(payload);
  if (e) stop(`${label}: ${JSON.stringify(e)}`);
}

// ---------------------------------------------------------------------------
// check — read-only
// ---------------------------------------------------------------------------

export async function phaseCheck({ state, io, log, gql, sessionExpires = null }) {
  void gql; // check is read-only; the snapshot is already in `state`
  const fns = describeFunctions(state);
  const ct = describeCartTransforms(state);
  const val = describeValidations(state);
  const pol = describePolicies(state);
  const adj = describeAdjustmentProduct(state.adjustmentProductMatches);
  const currency = currencyReadiness(state);
  const fingerprints = io.readSecretFingerprints();
  const gate = goNoGo(state, fingerprints);
  const prepare = planPrepare(state);
  const activate = planActivate(state);

  const leaseMin = sessionLeaseMinutes(sessionExpires);
  log(`\n=== Task 5B.3B.2 provisioning — CHECK (read-only) — ${state.shopName} (${currency.shopCurrency}) ===`);
  log(`app: ${state.app.title} (${state.app.apiKey})`);
  log(
    `session lease: ${leaseMin === null ? "unknown" : leaseMin.toFixed(1) + " min"} remaining ` +
      `(mutating phases require ≥ ${MUTATION_LEASE_MINUTES} min)`,
  );

  log(`\n1. CURRENT STATE`);
  log(`   adjustment product : ${adj.status}${adj.product ? ` — ${adj.product.id}` : ""}${adj.drift.length ? ` [${adj.drift.join("; ")}]` : ""}`);
  log(`   Cart Transforms    : ${state.cartTransforms.length} total — ours: ${ct.ours ? ct.ours.id : "none"}, foreign: ${ct.foreign.length}`);
  log(`   Validations        : ${state.validations.length} total — ours: ${val.ours ? `${val.ours.id} (enabled=${val.ours.enabled}, blockOnFailure=${val.ours.blockOnFailure})` : "none"}, foreign: ${val.foreign.length}`);
  log(`   shop enforcement_policy : ${pol.shop.present ? (pol.shop.parsed ? `present, parses — enabled=${pol.shop.parsed.enabled}, mode=${pol.shop.parsed.mode}` : "present but UNPARSEABLE") : "absent"}`);
  log(`   LNY01 pricing_policy    : ${pol.product.present ? (pol.product.parsed ? `present, parses — required=${pol.product.parsed.required}, active=${pol.product.parsed.active}` : "present but UNPARSEABLE") : "absent"}`);
  log(`   policy definitions      : shop=${pol.shopDefinitionPresent ? "exists" : "absent"}, product=${pol.productDefinitionPresent ? "exists" : "absent"}`);
  log(`   dev Function handles    : ${TRANSFORM_HANDLE} → ${fns.transform.registered ? fns.transform.functionId : "NOT REGISTERED"}; ${VALIDATION_HANDLE} → ${fns.validation.registered ? fns.validation.functionId : "NOT REGISTERED"}`);
  log(`   both handles activatable : ${fns.transform.registered && fns.validation.registered ? "YES" : "NO"}`);
  log(`   signing fingerprints    : app-server ${fingerprints.appServer}, transform ${fingerprints.transform}, validation ${fingerprints.validation}`);

  log(`\n2. PLANNED --prepare MUTATIONS`);
  for (const s of prepare.steps) log(`   - ${s.op}: ${s.detail}${s.idempotent ? "  (idempotent)" : ""}`);

  log(`\n3. PLANNED --activate MUTATIONS`);
  for (const s of activate.steps) log(`   - ${s.op}: ${s.detail}${s.idempotent ? "  (idempotent)" : ""}`);

  log(`\n4. CURRENCY READINESS`);
  log(`   profile ${currency.profileCurrency ?? "?"} / shop ${currency.shopCurrency ?? "?"} → ${currency.enforceable ? "ENFORCEABLE" : `NOT enforceable (${currency.reason})`}`);

  log(`\n5. CONFLICTS`);
  const blockers = prepare.blockers;
  if (!blockers.length) log(`   none`);
  else for (const b of blockers) log(`   ✖ ${b}`);

  log(`\n6. IDEMPOTENCY`);
  log(`   receipt phaseReached: ${state.receipt ? state.receipt.phaseReached : "(no receipt)"}`);
  log(`   adjustment product : ${adj.status === "ok" ? "converged" : adj.status === "repairable" ? "will be reconciled in place" : adj.status}`);
  log(`   re-running any phase reconciles rather than duplicates.`);

  log(`\n7. GO / NO-GO`);
  for (const phase of ["prepare", "activate", "enable-pilot", "rollback-check"]) {
    const g = gate[phase];
    log(`   ${phase.padEnd(14)} ${g.go ? "GO" : "NO-GO"}${g.blockers.length ? `  — ${g.blockers.join("; ")}` : ""}`);
  }

  return { phase: "check", mutated: false, gate };
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

export async function phasePrepare({ state, gql, io, log }) {
  const plan = planPrepare(state);
  if (plan.blockers.length) stop(`--prepare blocked:\n  - ${plan.blockers.join("\n  - ")}`);

  const before = describePolicies(state);
  const beforeState = {
    shopEnabled: before.shop.parsed ? before.shop.parsed.enabled : null,
    shopMode: before.shop.parsed ? before.shop.parsed.mode : null,
    lny01Required: before.product.parsed ? before.product.parsed.required : null,
  };

  // 1. adjustment product / variant
  const adj = describeAdjustmentProduct(state.adjustmentProductMatches);
  let adjProductId = adj.productId || null;
  let adjVariantId = adj.variantId || null;

  if (adj.status === "absent") {
    const created = await gql(
      `mutation($p: ProductCreateInput!) {
         productCreate(product: $p) { product { id variants(first: 1) { nodes { id } } } userErrors { field message } }
       }`,
      {
        p: {
          title: ADJ_PRODUCT_TITLE,
          status: "ACTIVE",
          vendor: ADJ_PRODUCT_VENDOR,
          productType: ADJ_PRODUCT_TYPE,
          tags: ADJ_PRODUCT_TAGS,
          descriptionHtml: ADJ_PRODUCT_DESCRIPTION_HTML,
        },
      },
    );
    assertNoUserErrors(io, created.productCreate, "productCreate");
    adjProductId = created.productCreate.product.id;
    adjVariantId = created.productCreate.product.variants.nodes[0].id;
    await reconcileAdjVariant(gql, io, adjProductId, adjVariantId, {
      price: ADJ_VARIANT_DESIRED.price,
      inventoryPolicy: ADJ_VARIANT_DESIRED.inventoryPolicy,
      taxable: ADJ_VARIANT_DESIRED.taxable,
      inventoryItem: { tracked: ADJ_VARIANT_DESIRED.inventoryTracked, requiresShipping: ADJ_VARIANT_DESIRED.requiresShipping },
    });
    log(`  created adjustment product ${adjProductId} (variant ${adjVariantId})`);
  } else if (adj.status === "repairable") {
    if (adj.productUpdate) {
      const u = await gql(
        `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id } userErrors { field message } } }`,
        { p: adj.productUpdate },
      );
      assertNoUserErrors(io, u.productUpdate, "productUpdate");
      log(`  repaired adjustment product drift`);
    }
    if (adj.variantUpdate) {
      await reconcileAdjVariant(gql, io, adjProductId, adjVariantId, stripId(adj.variantUpdate));
      log(`  repaired adjustment variant drift`);
    }
  } else {
    log(`  adjustment product + variant already converged (${adjProductId})`);
  }

  // 2. .env signing config (git-ignored; secret reused if present)
  const adjVariantGid = adjVariantId;
  const secretFp = io.writeSigningEnv(adjVariantGid);
  log(`  .env written: envelope v2, IMPRINTID_CART_SIGNING_SECRET (sha256:${secretFp}…), IMPRINTID_ADJUSTMENT_VARIANT_ID=${adjVariantGid}`);

  // 3. metafield definitions
  const shopDefId = state.shopPolicyDefinitionId || (await ensureDefinition(gql, io, "SHOP", SHOP_POLICY_KEY, "ImprintID enforcement policy"));
  const prodDefId = state.productPolicyDefinitionId || (await ensureDefinition(gql, io, "PRODUCT", PRODUCT_POLICY_KEY, "ImprintID pricing policy"));

  // 4. policy VALUES — enforcement DISABLED
  const shopValue = shopPolicyValue({ adjustmentVariantGid: adjVariantGid, enabled: false });
  const productValue = productPolicyValue();
  const set = await gql(
    `mutation($m: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $m) { metafields { id namespace key } userErrors { field message code } }
     }`,
    {
      m: [
        { ownerId: state.shopId, namespace: APP_NS, key: SHOP_POLICY_KEY, type: "json", value: JSON.stringify(shopValue) },
        { ownerId: LNY01_PRODUCT_GID, namespace: APP_NS, key: PRODUCT_POLICY_KEY, type: "json", value: JSON.stringify(productValue) },
      ],
    },
  );
  assertNoUserErrors(io, set.metafieldsSet, "metafieldsSet");
  const shopMfId = set.metafieldsSet.metafields.find((m) => m.key === SHOP_POLICY_KEY)?.id ?? null;
  const prodMfId = set.metafieldsSet.metafields.find((m) => m.key === PRODUCT_POLICY_KEY)?.id ?? null;
  log(`  wrote shop enforcement_policy (enabled: FALSE) + LNY01 pricing_policy (required: true)`);

  // 5. read back + strict-parse
  const rb = await readBackPolicies(gql, io);
  if (!rb.shop || !rb.product) stop(`a policy metafield did not strict-parse after writing (shop=${!!rb.shop}, product=${!!rb.product}) — investigate before --activate.`);

  const currency = currencyReadiness(state);
  const receipt = io.writeReceipt({
    scriptVersion: SCRIPT_VERSION,
    app: state.app,
    store: state.shopName ? undefined : undefined,
    phaseReached: "prepared",
    resources: {
      adjustmentProductId: adjProductId,
      adjustmentVariantId: adjVariantId,
      shopPolicyDefinitionId: shopDefId,
      productPolicyDefinitionId: prodDefId,
      shopPolicyMetafieldId: shopMfId,
      productPolicyMetafieldId: prodMfId,
    },
    policyState: { before: beforeState, after: { shopEnabled: false, shopMode: "pilot", lny01Required: true } },
    secretFingerprint: secretFp,
    currency: { profile: currency.profileCurrency, shop: currency.shopCurrency, enforceable: currency.enforceable, reason: currency.reason },
  });

  log(`\n--prepare complete. Receipt: ${io.receiptPath()}`);
  log(`NEXT (manual compilation boundary):`);
  log(`  1. npm run fn:config          # bakes the SAME secret into both Functions from .env`);
  log(`  2. restart \`npm run dev\` with Ctrl+C, then run it again`);
  log(`  3. node scripts/shopify/provision.mjs --check   # confirm all three fingerprints match`);
  log(`Enforcement is DISABLED. No Cart Transform, no active Validation was created.`);

  return { phase: "prepare", mutated: true, receipt };
}

async function reconcileAdjVariant(gql, io, productId, variantId, fields) {
  const u = await gql(
    `mutation($pid: ID!, $vars: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $pid, variants: $vars) { productVariants { id price inventoryPolicy } userErrors { field message } }
     }`,
    { pid: productId, vars: [{ id: variantId, ...fields }] },
  );
  assertNoUserErrors(io, u.productVariantsBulkUpdate, "productVariantsBulkUpdate");
}

function stripId(obj) {
  const { id, ...rest } = obj;
  return rest;
}

async function ensureDefinition(gql, io, ownerType, key, name) {
  const r = await gql(
    `mutation($d: MetafieldDefinitionInput!) {
       metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { field message code } }
     }`,
    { d: { namespace: APP_NS, key, name, ownerType, type: "json", access: { admin: "MERCHANT_READ" } } },
  );
  const errs = r.metafieldDefinitionCreate.userErrors || [];
  const taken = errs.find((e) => e.code === "TAKEN" || /taken|already exists/i.test(e.message || ""));
  if (errs.length && !taken) stop(`metafieldDefinitionCreate(${ownerType}/${key}): ${JSON.stringify(errs)}`);
  return r.metafieldDefinitionCreate.createdDefinition?.id ?? null;
}

async function readBackPolicies(gql, io) {
  const rb = await gql(
    `query($pid: ID!) {
       shop { metafield(namespace: "${APP_NS}", key: "${SHOP_POLICY_KEY}") { jsonValue } }
       product(id: $pid) { metafield(namespace: "${APP_NS}", key: "${PRODUCT_POLICY_KEY}") { jsonValue } }
     }`,
    { pid: LNY01_PRODUCT_GID },
  );
  return {
    shop: io.parseShopEnforcementPolicy(rb.shop?.metafield?.jsonValue ?? null),
    product: io.parseProductPricingPolicy(rb.product?.metafield?.jsonValue ?? null),
  };
}

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

export async function phaseActivate({ state, gql, io, log }) {
  const fingerprints = io.readSecretFingerprints();
  const gate = canActivate(state, fingerprints);
  if (!gate.ok) stop(`--activate blocked:\n  - ${gate.blockers.join("\n  - ")}`);

  const plan = planActivate(state);
  const ct = describeCartTransforms(state);
  const val = describeValidations(state);

  let cartTransformId = ct.ours ? ct.ours.id : null;
  let validationId = val.ours ? val.ours.id : null;

  if (!ct.ours) {
    const r = await gql(
      `mutation($h: String!) {
         cartTransformCreate(functionHandle: $h, blockOnFailure: true) { cartTransform { id blockOnFailure } userErrors { field message } }
       }`,
      { h: TRANSFORM_HANDLE },
    );
    assertNoUserErrors(io, r.cartTransformCreate, "cartTransformCreate");
    cartTransformId = r.cartTransformCreate.cartTransform.id;
    log(`  created Cart Transform ${cartTransformId} (blockOnFailure: true)`);
  } else {
    log(`  Cart Transform already exists: ${cartTransformId}`);
  }

  if (!val.ours) {
    const r = await gql(
      `mutation($v: ValidationCreateInput!) {
         validationCreate(validation: $v) { validation { id title enabled blockOnFailure } userErrors { field message } }
       }`,
      { v: { functionHandle: VALIDATION_HANDLE, title: VALIDATION_TITLE, enable: true, blockOnFailure: true } },
    );
    assertNoUserErrors(io, r.validationCreate, "validationCreate");
    validationId = r.validationCreate.validation.id;
    log(`  created Validation ${validationId} "${VALIDATION_TITLE}" (enabled: true, blockOnFailure: true)`);
  } else if (!val.ours.enabled || !val.ours.blockOnFailure) {
    const r = await gql(
      `mutation($id: ID!) { validationUpdate(id: $id, validation: { enable: true, blockOnFailure: true }) { validation { id enabled blockOnFailure } userErrors { field message } } }`,
      { id: validationId },
    );
    assertNoUserErrors(io, r.validationUpdate, "validationUpdate");
    log(`  updated Validation ${validationId} → enabled: true, blockOnFailure: true`);
  } else {
    log(`  Validation already active: ${validationId}`);
  }

  const receipt = io.writeReceipt({
    phaseReached: "activated",
    resources: { cartTransformId, validationId },
    secretFingerprint: fingerprints.appServer,
  });

  log(`\n--activate complete. Cart Transform + Validation are live with blockOnFailure.`);
  log(`Enforcement policy is STILL DISABLED — no product is enforced yet.`);
  log(`Plan preview (already applied): ${plan.steps.map((s) => s.op).join(", ")}`);
  return { phase: "activate", mutated: true, receipt };
}

// ---------------------------------------------------------------------------
// enable-pilot
// ---------------------------------------------------------------------------

export async function phaseEnablePilot({ state, gql, io, log }) {
  const gate = canEnablePilot(state);
  if (!gate.ok) stop(`--enable-pilot blocked:\n  - ${gate.blockers.join("\n  - ")}`);

  const currency = currencyReadiness(state);
  if (!currency.enforceable) {
    stop(
      `--enable-pilot blocked: currency is not enforceable (${currency.reason}; profile ${currency.profileCurrency} / shop ${currency.shopCurrency}). ` +
        "Align the pricing-profile currency with the shop currency first — the initial release performs no FX.",
    );
  }

  const adj = describeAdjustmentProduct(state.adjustmentProductMatches);
  const adjVariantGid = adj.variantId || state.receipt?.resources?.adjustmentVariantId;
  if (!adjVariantGid) stop("--enable-pilot blocked: cannot resolve the adjustment variant GID from the store or the receipt.");

  const before = describePolicies(state).shop.parsed;
  const value = shopPolicyValue({ adjustmentVariantGid: adjVariantGid, enabled: true });
  const set = await gql(
    `mutation($m: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $m) { metafields { id key } userErrors { field message code } }
     }`,
    { m: [{ ownerId: state.shopId, namespace: APP_NS, key: SHOP_POLICY_KEY, type: "json", value: JSON.stringify(value) }] },
  );
  assertNoUserErrors(io, set.metafieldsSet, "metafieldsSet");

  // read back
  const rb = await gql(
    `{ shop { metafield(namespace: "${APP_NS}", key: "${SHOP_POLICY_KEY}") { jsonValue } } }`,
  );
  const parsed = io.parseShopEnforcementPolicy(rb.shop?.metafield?.jsonValue ?? null);
  if (!parsed || !parsed.enabled || parsed.mode !== "pilot") {
    stop(`read-back after enable failed: ${JSON.stringify(parsed)} — expected { enabled: true, mode: "pilot" }.`);
  }

  const receipt = io.writeReceipt({
    phaseReached: "pilot-enabled",
    policyState: {
      before: { shopEnabled: before ? before.enabled : null, shopMode: before ? before.mode : null },
      after: { shopEnabled: true, shopMode: "pilot", lny01Required: true },
    },
  });

  log(`\n--enable-pilot complete. Pilot enforcement is LIVE for LNY01 only (mode: pilot; never universal).`);
  log(`Every other product is untouched. Roll back with: node scripts/shopify/provision.mjs --rollback-check`);
  return { phase: "enable-pilot", mutated: true, receipt };
}

// ---------------------------------------------------------------------------
// rollback-check
// ---------------------------------------------------------------------------

export async function phaseRollbackCheck({ state, io, log, gql }) {
  void gql; // rollback-check executes nothing
  const receipt = state.receipt;
  if (!receipt) {
    log(`\nNo receipt at ${io.receiptPath()} — nothing this provisioner created is recorded. Rollback plan is empty.`);
    return { phase: "rollback-check", mutated: false, plan: { steps: [], notTouched: [], executed: false } };
  }
  const plan = buildRollbackPlan(receipt, state);
  log(`\n=== ROLLBACK PLAN (NOT executed) — reverses receipt phase "${plan.phaseReached}" ===`);
  for (const s of plan.steps) log(`  ${s.order}. ${s.mutation} — ${s.detail}   [${s.target}]`);
  if (!plan.steps.length) log(`  (nothing to reverse)`);
  log(`\nResources NOT touched by this rollback (foreign / not in the receipt):`);
  if (!plan.notTouched.length) log(`  (none)`);
  else for (const n of plan.notTouched) log(`  - ${n}`);
  log(`\nThis command executed NOTHING. Apply the plan manually, newest step first.`);
  return { phase: "rollback-check", mutated: false, plan };
}

export { StopError };
