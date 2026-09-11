/**
 * Task 5B.3B.2 — PURE reconciliation + planning for the phased provisioner.
 *
 * Nothing here does IO. Every function takes a plain snapshot of the current Shopify
 * state (see `runtime.mjs#readState`) plus, where relevant, the recovery receipt, and
 * returns a plan / classification / gate decision. This is where every idempotency and
 * ordering guarantee lives, so it can be unit-tested without a network.
 */

import {
  ADJ_PRODUCT_TAGS,
  ADJ_PRODUCT_TITLE,
  ADJ_VARIANT_DESIRED,
  APP_NS,
  LNY01_PRODUCT_GID,
  MUTATING_PHASES,
  MUTATION_LEASE_MINUTES,
  PHASE_RANK,
  PRODUCT_POLICY_KEY,
  SHOP_POLICY_KEY,
  TRANSFORM_HANDLE,
  VALIDATION_HANDLE,
  VALIDATION_TITLE,
} from "./constants.mjs";
import { resolveEnforceableCurrency } from "../../app/lib/pricing-api/currency-contract.ts";
import {
  parseShopEnforcementPolicy,
  parseProductPricingPolicy,
} from "../../app/lib/pricing-api/policy-metafields.ts";

// ---------------------------------------------------------------------------
// Mutation-phase session lease guard
// ---------------------------------------------------------------------------

/** Minutes of offline-session validity left. `null` when there is no recorded expiry
 * (cannot be confirmed → treated as a lease failure for a mutating phase). */
export function sessionLeaseMinutes(expires, now = Date.now()) {
  if (expires === null || expires === undefined) return null;
  const at = expires instanceof Date ? expires.getTime() : new Date(expires).getTime();
  if (!Number.isFinite(at)) return null;
  const nowMs = now instanceof Date ? now.getTime() : now;
  return (at - nowMs) / 60000;
}

/**
 * Blockers that must be empty before a MUTATING phase (`prepare` / `activate` /
 * `enable-pilot`) may start. `check` / `rollback-check` are never gated. A mutating
 * phase needs at least `MUTATION_LEASE_MINUTES` of confirmed remaining session validity;
 * an unknown or too-short lease fails closed (re-open the app in Shopify admin to
 * refresh the expiring offline token — this tool never performs OAuth itself).
 */
export function leaseBlockers(expires, phase, now = Date.now()) {
  if (!MUTATING_PHASES.includes(phase)) return [];
  const mins = sessionLeaseMinutes(expires, now);
  if (mins === null) {
    return [
      `cannot confirm the offline session is valid for ${MUTATION_LEASE_MINUTES} min (no recorded expiry) — ` +
        "re-open the ImprintID app in Shopify admin to refresh it, then retry",
    ];
  }
  if (mins < MUTATION_LEASE_MINUTES) {
    return [
      `the offline session has ${mins.toFixed(1)} min of validity left; a mutating phase (${phase}) needs at least ` +
        `${MUTATION_LEASE_MINUTES} — re-open the ImprintID app in Shopify admin to refresh it, then retry`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Adjustment product / variant
// ---------------------------------------------------------------------------

/**
 * Classifies the adjustment product against the exact shape this provisioner owns.
 *
 *   status:
 *     "absent"     — no product with the reserved title
 *     "ambiguous"  — more than one, OR one with ≠ 1 variant → STOP (never auto-repaired)
 *     "ok"         — present and every owned field already matches
 *     "repairable" — present, exactly 1 variant, only owned fields drift → `--prepare` fixes it
 *
 * `drift` lists every mismatch in human terms. `productUpdate` / `variantUpdate` carry
 * the minimal repair payloads (only the fields that are wrong).
 */
export function describeAdjustmentProduct(matches) {
  const list = Array.isArray(matches) ? matches.filter((p) => p && p.title === ADJ_PRODUCT_TITLE) : [];
  if (list.length === 0) return { status: "absent", drift: [], product: null };
  if (list.length > 1) {
    return { status: "ambiguous", drift: [`${list.length} products titled "${ADJ_PRODUCT_TITLE}" — exactly one is required`], product: null };
  }
  const product = list[0];
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (variants.length !== 1) {
    return { status: "ambiguous", drift: [`the adjustment product has ${variants.length} variants — exactly one is required`], product };
  }

  const v = variants[0];
  const drift = [];
  const productUpdate = { id: product.id };
  const variantUpdate = { id: v.id };

  if (product.status !== "ACTIVE") {
    drift.push(`product status is ${product.status}, expected ACTIVE`);
    productUpdate.status = "ACTIVE";
  }
  const tags = Array.isArray(product.tags) ? product.tags : [];
  const missingTags = ADJ_PRODUCT_TAGS.filter((t) => !tags.includes(t));
  if (missingTags.length) {
    drift.push(`missing internal tags: ${missingTags.join(", ")}`);
    productUpdate.tags = [...new Set([...tags, ...ADJ_PRODUCT_TAGS])];
  }

  if (String(v.price) !== ADJ_VARIANT_DESIRED.price) {
    drift.push(`variant price is ${v.price}, expected ${ADJ_VARIANT_DESIRED.price}`);
    variantUpdate.price = ADJ_VARIANT_DESIRED.price;
  }
  if (v.inventoryPolicy !== ADJ_VARIANT_DESIRED.inventoryPolicy) {
    drift.push(`variant inventoryPolicy is ${v.inventoryPolicy}, expected ${ADJ_VARIANT_DESIRED.inventoryPolicy}`);
    variantUpdate.inventoryPolicy = ADJ_VARIANT_DESIRED.inventoryPolicy;
  }
  if (v.taxable !== ADJ_VARIANT_DESIRED.taxable) {
    drift.push(`variant taxable is ${v.taxable}, expected ${ADJ_VARIANT_DESIRED.taxable}`);
    variantUpdate.taxable = ADJ_VARIANT_DESIRED.taxable;
  }
  const inv = v.inventoryItem || {};
  if (inv.tracked !== ADJ_VARIANT_DESIRED.inventoryTracked) {
    drift.push(`variant inventory tracked is ${inv.tracked}, expected ${ADJ_VARIANT_DESIRED.inventoryTracked}`);
    variantUpdate.inventoryItem = { ...(variantUpdate.inventoryItem || {}), tracked: ADJ_VARIANT_DESIRED.inventoryTracked };
  }
  if (inv.requiresShipping !== ADJ_VARIANT_DESIRED.requiresShipping) {
    drift.push(`variant requiresShipping is ${inv.requiresShipping}, expected ${ADJ_VARIANT_DESIRED.requiresShipping}`);
    variantUpdate.inventoryItem = { ...(variantUpdate.inventoryItem || {}), requiresShipping: ADJ_VARIANT_DESIRED.requiresShipping };
  }

  // Publication: a provisioner-created product is never auto-published. If a human
  // published it to the Online Store, that is deliberate intent this tool will not
  // silently reverse — surface it, do not repair it.
  if (product.onlineStoreUrl) {
    return {
      status: "ambiguous",
      drift: [`the adjustment product is published to the Online Store (${product.onlineStoreUrl}) — unpublish it manually before continuing`],
      product,
    };
  }

  const productDrift = Object.keys(productUpdate).length > 1;
  const variantDrift = Object.keys(variantUpdate).length > 1;
  if (!productDrift && !variantDrift) {
    return { status: "ok", drift: [], product, variantId: v.id, productId: product.id };
  }
  return {
    status: "repairable",
    drift,
    product,
    productId: product.id,
    variantId: v.id,
    productUpdate: productDrift ? productUpdate : null,
    variantUpdate: variantDrift ? variantUpdate : null,
  };
}

// ---------------------------------------------------------------------------
// Cart Transform / Validation / Functions
// ---------------------------------------------------------------------------

/** The registered dev Function ids for our two handles, plus whether each handle is
 * available to activate. */
export function describeFunctions(state) {
  const fns = state.functions || [];
  const transformFn = fns.find((f) => f.apiType === "cart_transform");
  const validationFn = fns.find(
    (f) => f.apiType === "cart_checkout_validation" || f.apiType === "cart_and_checkout_validation",
  );
  return {
    transform: { registered: !!transformFn, functionId: transformFn ? transformFn.id : null, handle: TRANSFORM_HANDLE },
    validation: { registered: !!validationFn, functionId: validationFn ? validationFn.id : null, handle: VALIDATION_HANDLE },
  };
}

/** Our Cart Transform (if any) + any FOREIGN Cart Transform (→ blocker). */
export function describeCartTransforms(state) {
  const list = state.cartTransforms || [];
  const fns = describeFunctions(state);
  const ours = fns.transform.functionId ? list.find((t) => t.functionId === fns.transform.functionId) || null : null;
  const foreign = list.filter((t) => !ours || t.id !== ours.id);
  return { ours, foreign };
}

/** Our Validation (matched by title) + any FOREIGN Validation (→ blocker). */
export function describeValidations(state) {
  const list = state.validations || [];
  const ours = list.find((v) => v.title === VALIDATION_TITLE) || null;
  const foreign = list.filter((v) => v.title !== VALIDATION_TITLE);
  return { ours, foreign };
}

// ---------------------------------------------------------------------------
// Policy metafields
// ---------------------------------------------------------------------------

export function describePolicies(state) {
  const shopRaw = state.shopPolicyJson ?? null;
  const productRaw = state.lny01PolicyJson ?? null;
  return {
    shop: { present: shopRaw !== null, parsed: parseShopEnforcementPolicy(shopRaw), raw: shopRaw },
    product: { present: productRaw !== null, parsed: parseProductPricingPolicy(productRaw), raw: productRaw },
    shopDefinitionPresent: !!state.shopPolicyDefinitionId,
    productDefinitionPresent: !!state.productPolicyDefinitionId,
  };
}

// ---------------------------------------------------------------------------
// Currency readiness
// ---------------------------------------------------------------------------

export function currencyReadiness(state) {
  const result = resolveEnforceableCurrency(state.profileCurrency, state.shopCurrency);
  return {
    profileCurrency: state.profileCurrency ?? null,
    shopCurrency: state.shopCurrency ?? null,
    enforceable: result.ok,
    reason: result.ok ? null : result.reason,
  };
}

// ---------------------------------------------------------------------------
// Conflicts / blockers (foreign or ambiguous resources → STOP)
// ---------------------------------------------------------------------------

export function collectBlockers(state) {
  const blockers = [];
  const adj = describeAdjustmentProduct(state.adjustmentProductMatches);
  if (adj.status === "ambiguous") blockers.push(...adj.drift);

  const ct = describeCartTransforms(state);
  if (ct.foreign.length) blockers.push(`unrelated Cart Transform(s) exist: ${ct.foreign.map((t) => t.id).join(", ")}`);

  const val = describeValidations(state);
  if (val.foreign.length) blockers.push(`unrelated Validation(s) exist: ${val.foreign.map((v) => `${v.id} "${v.title}"`).join(", ")}`);

  return blockers;
}

// ---------------------------------------------------------------------------
// Phase plans (ordered lists of the mutations each phase would perform)
// ---------------------------------------------------------------------------

/** `--prepare`: adjustment product/variant + secret/.env + definitions + metafields
 * (enforcement DISABLED). Never the Cart Transform, never an active Validation. */
export function planPrepare(state) {
  const steps = [];
  const adj = describeAdjustmentProduct(state.adjustmentProductMatches);

  if (adj.status === "absent") {
    steps.push({ op: "productCreate", detail: `create "${ADJ_PRODUCT_TITLE}" (ACTIVE, unpublished, internal tags)` });
    steps.push({ op: "productVariantsBulkUpdate", detail: `set the sole variant: price ${ADJ_VARIANT_DESIRED.price}, inventoryPolicy CONTINUE, untracked, no shipping, not taxable` });
  } else if (adj.status === "repairable") {
    if (adj.productUpdate) steps.push({ op: "productUpdate", detail: `repair adjustment product drift: ${adj.drift.join("; ")}`, idempotent: true });
    if (adj.variantUpdate) steps.push({ op: "productVariantsBulkUpdate", detail: `repair adjustment variant drift`, idempotent: true });
  } else if (adj.status === "ok") {
    steps.push({ op: "(none)", detail: "adjustment product + variant already match", idempotent: true });
  }

  steps.push({ op: "(local) .env", detail: "write IMPRINTID_CART_ENVELOPE_VERSION=2, IMPRINTID_CART_SIGNING_SECRET (git-ignored; reused if already present), IMPRINTID_ADJUSTMENT_VARIANT_ID", idempotent: true });

  const pol = describePolicies(state);
  if (!pol.shopDefinitionPresent) steps.push({ op: "metafieldDefinitionCreate", detail: `SHOP ${APP_NS}/${SHOP_POLICY_KEY} (json, MERCHANT_READ)` });
  else steps.push({ op: "(none)", detail: `SHOP ${APP_NS}/${SHOP_POLICY_KEY} definition already exists`, idempotent: true });
  if (!pol.productDefinitionPresent) steps.push({ op: "metafieldDefinitionCreate", detail: `PRODUCT ${APP_NS}/${PRODUCT_POLICY_KEY} (json, MERCHANT_READ)` });
  else steps.push({ op: "(none)", detail: `PRODUCT ${APP_NS}/${PRODUCT_POLICY_KEY} definition already exists`, idempotent: true });

  steps.push({ op: "metafieldsSet", detail: `shop ${SHOP_POLICY_KEY} = { mode: pilot, enabled: FALSE, ... } + LNY01 ${PRODUCT_POLICY_KEY} = { required: true, active: true, ... }`, idempotent: true });

  return { steps, blockers: collectBlockers(state) };
}

/** `--activate`: ONE Cart Transform + ONE Validation, both blockOnFailure. Enforcement
 * stays disabled. Requires prepared-state evidence + matching fingerprints (checked by
 * `canActivate`, not here). */
export function planActivate(state) {
  const steps = [];
  const ct = describeCartTransforms(state);
  if (!ct.ours) steps.push({ op: "cartTransformCreate", detail: `functionHandle ${TRANSFORM_HANDLE}, blockOnFailure: true` });
  else steps.push({ op: "(none)", detail: `Cart Transform already exists: ${ct.ours.id}`, idempotent: true });

  const val = describeValidations(state);
  if (!val.ours) steps.push({ op: "validationCreate", detail: `functionHandle ${VALIDATION_HANDLE}, title "${VALIDATION_TITLE}", enable: true, blockOnFailure: true` });
  else if (!val.ours.enabled || !val.ours.blockOnFailure) steps.push({ op: "validationUpdate", detail: `enable + blockOnFailure on ${val.ours.id}`, idempotent: true });
  else steps.push({ op: "(none)", detail: `Validation already active: ${val.ours.id}`, idempotent: true });

  return { steps, blockers: collectBlockers(state) };
}

/** `--enable-pilot`: flip shop `enforcement_policy.enabled` to true (mode stays pilot;
 * only LNY01 carries a product policy, so only LNY01 is enforced). Never universal. */
export function planEnablePilot(state) {
  const adj = describeAdjustmentProduct(state.adjustmentProductMatches);
  const adjVariantGid = adj.variantId || (state.receipt && state.receipt.resources && state.receipt.resources.adjustmentVariantId) || "<adjustment variant>";
  return {
    steps: [
      {
        op: "metafieldsSet",
        detail: `shop ${SHOP_POLICY_KEY} → { mode: pilot, enabled: TRUE, adjustmentVariantGid: ${adjVariantGid}, ... } (LNY01 only; NEVER universal)`,
      },
    ],
    blockers: collectBlockers(state),
  };
}

// ---------------------------------------------------------------------------
// Phase gates — no phase may silently perform a later phase
// ---------------------------------------------------------------------------

export function phaseRank(receipt) {
  return PHASE_RANK[(receipt && receipt.phaseReached) || "none"] ?? 0;
}

/** Prepared-state evidence: the receipt says `prepared`+ AND the live store still shows
 * the adjustment product, both definitions, and both parseable policy metafields with
 * enforcement DISABLED. */
export function prepareComplete(state) {
  const receipt = state.receipt;
  if (phaseRank(receipt) < PHASE_RANK.prepared) return { ok: false, blockers: ["no receipt evidence of a completed --prepare"] };

  const blockers = [];
  const adj = describeAdjustmentProduct(state.adjustmentProductMatches);
  if (!(adj.status === "ok" || adj.status === "repairable")) blockers.push("adjustment product/variant is not in a prepared state");
  const pol = describePolicies(state);
  if (!pol.shopDefinitionPresent) blockers.push("shop policy metafield definition missing");
  if (!pol.productDefinitionPresent) blockers.push("product policy metafield definition missing");
  if (!pol.shop.parsed) blockers.push("shop enforcement_policy metafield missing or unparseable");
  if (!pol.product.parsed) blockers.push("LNY01 pricing_policy metafield missing or unparseable");
  if (pol.shop.parsed && pol.shop.parsed.enabled) blockers.push("shop enforcement_policy is already enabled — expected disabled after --prepare");
  return { ok: blockers.length === 0, blockers };
}

/**
 * `--activate` gate. Requires: prepared-state evidence, NO blockers, and all three
 * signing-secret fingerprints equal + non-empty (`fingerprints` = { appServer,
 * transform, validation } — 8-hex strings from `runtime.mjs`).
 */
export function canActivate(state, fingerprints) {
  const blockers = [];
  const prep = prepareComplete(state);
  if (!prep.ok) blockers.push(...prep.blockers);
  blockers.push(...collectBlockers(state));

  const fpBlockers = fingerprintBlockers(fingerprints);
  blockers.push(...fpBlockers);

  return { ok: blockers.length === 0, blockers };
}

export function fingerprintBlockers(fingerprints) {
  const fp = fingerprints || {};
  const blockers = [];
  const empty = "00000000";
  if (!fp.appServer || fp.appServer === empty) blockers.push("app-server signing secret is unset (write .env via --prepare, restart the dev server)");
  if (!fp.transform || fp.transform === empty) blockers.push("Cart Transform config secret is unset — run `npm run fn:config`");
  if (!fp.validation || fp.validation === empty) blockers.push("Validation config secret is unset — run `npm run fn:config`");
  if (blockers.length) return blockers;
  if (fp.appServer !== fp.transform || fp.appServer !== fp.validation) {
    blockers.push(
      `signing-secret fingerprint mismatch (app-server ${fp.appServer}, transform ${fp.transform}, validation ${fp.validation}) — ` +
        "run `npm run fn:config` and restart the dev session",
    );
  }
  return blockers;
}

/** `--enable-pilot` gate. Requires: activated evidence — both resources exist and read
 * back correctly (Cart Transform present + blockOnFailure; Validation present + enabled
 * + blockOnFailure) — plus no blockers. */
export function canEnablePilot(state) {
  const blockers = [];
  if (phaseRank(state.receipt) < PHASE_RANK.activated) blockers.push("no receipt evidence of a completed --activate");

  const ct = describeCartTransforms(state);
  if (!ct.ours) blockers.push("Cart Transform does not exist");
  else if (!ct.ours.blockOnFailure) blockers.push("Cart Transform blockOnFailure is not true");

  const val = describeValidations(state);
  if (!val.ours) blockers.push("Validation does not exist");
  else {
    if (!val.ours.enabled) blockers.push("Validation is not enabled");
    if (!val.ours.blockOnFailure) blockers.push("Validation blockOnFailure is not true");
  }

  const prep = prepareComplete(state);
  if (!prep.ok) blockers.push(...prep.blockers);

  blockers.push(...collectBlockers(state));
  return { ok: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// GO / NO-GO summary for --check
// ---------------------------------------------------------------------------

export function goNoGo(state, fingerprints) {
  const blockers = collectBlockers(state);
  const prep = prepareComplete(state);
  const act = canActivate(state, fingerprints);
  const pilot = canEnablePilot(state);
  const currency = currencyReadiness(state);

  return {
    prepare: { go: blockers.length === 0, blockers },
    activate: { go: act.ok, blockers: act.blockers },
    "enable-pilot": {
      go: pilot.ok && currency.enforceable,
      blockers: [...pilot.blockers, ...(currency.enforceable ? [] : [`currency not enforceable: ${currency.reason} (profile ${currency.profileCurrency} / shop ${currency.shopCurrency})`])],
    },
    "rollback-check": { go: true, blockers: [] },
    _preparedEvidence: prep.ok,
  };
}

// ---------------------------------------------------------------------------
// Rollback plan (never executed by --rollback-check)
// ---------------------------------------------------------------------------

/**
 * An exact, ordered plan to reverse whatever the receipt says was done — referencing
 * ONLY resource ids the provisioner recorded as its own. Nothing is executed.
 */
export function buildRollbackPlan(receipt, state) {
  const r = (receipt && receipt.resources) || {};
  const reached = (receipt && receipt.phaseReached) || "none";
  const steps = [];

  // Reverse order of creation. Each step is tagged with the receipt field it came from.
  if (PHASE_RANK[reached] >= PHASE_RANK["pilot-enabled"]) {
    steps.push({
      order: steps.length + 1,
      mutation: "metafieldsSet",
      detail: `shop ${SHOP_POLICY_KEY} → { ..., enabled: false } (disable pilot enforcement; leaves the metafield in place)`,
      target: "app-owned shop metafield (provisioner-written)",
    });
  }
  if (PHASE_RANK[reached] >= PHASE_RANK.activated) {
    if (r.validationId) steps.push({ order: steps.length + 1, mutation: "validationDelete", detail: `id ${r.validationId}`, target: "receipt.resources.validationId" });
    if (r.cartTransformId) steps.push({ order: steps.length + 1, mutation: "cartTransformDelete", detail: `id ${r.cartTransformId}`, target: "receipt.resources.cartTransformId" });
  }
  if (PHASE_RANK[reached] >= PHASE_RANK.prepared) {
    steps.push({
      order: steps.length + 1,
      mutation: "metafieldsDelete",
      detail: `[{ ownerId: <shop>, namespace ${APP_NS}, key ${SHOP_POLICY_KEY} }, { ownerId: ${LNY01_PRODUCT_GID}, namespace ${APP_NS}, key ${PRODUCT_POLICY_KEY} }]`,
      target: "provisioner-written policy values",
    });
    if (r.shopPolicyDefinitionId) steps.push({ order: steps.length + 1, mutation: "metafieldDefinitionDelete", detail: `id ${r.shopPolicyDefinitionId} (deleteAllAssociatedMetafields: true)`, target: "receipt.resources.shopPolicyDefinitionId" });
    if (r.productPolicyDefinitionId) steps.push({ order: steps.length + 1, mutation: "metafieldDefinitionDelete", detail: `id ${r.productPolicyDefinitionId} (deleteAllAssociatedMetafields: true)`, target: "receipt.resources.productPolicyDefinitionId" });
    if (r.adjustmentProductId) steps.push({ order: steps.length + 1, mutation: "productDelete", detail: `id ${r.adjustmentProductId} (removes its sole variant)`, target: "receipt.resources.adjustmentProductId" });
    steps.push({
      order: steps.length + 1,
      mutation: "(local)",
      detail: "remove IMPRINTID_CART_ENVELOPE_VERSION / IMPRINTID_CART_SIGNING_SECRET / IMPRINTID_ADJUSTMENT_VARIANT_ID from .env, then `npm run fn:config` to re-write both Functions with the fail-closed empty secret",
      target: "local files only",
    });
  }

  // Anything present on the store that the receipt does NOT claim — never touched.
  const notTouched = [];
  const ct = describeCartTransforms(state);
  const val = describeValidations(state);
  for (const t of ct.foreign) notTouched.push(`Cart Transform ${t.id} (foreign)`);
  for (const v of val.foreign) notTouched.push(`Validation ${v.id} "${v.title}" (foreign)`);
  if (ct.ours && ct.ours.id !== r.cartTransformId) notTouched.push(`Cart Transform ${ct.ours.id} (present but not in the receipt)`);
  if (val.ours && val.ours.id !== r.validationId) notTouched.push(`Validation ${val.ours.id} (present but not in the receipt)`);

  return { phaseReached: reached, steps, notTouched, executed: false };
}
