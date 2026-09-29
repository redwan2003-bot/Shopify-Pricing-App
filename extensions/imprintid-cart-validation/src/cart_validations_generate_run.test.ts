import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  runValidation,
  cartValidationsGenerateRun,
  activationReadiness,
} from "./cart_validations_generate_run.ts";
import type { NormalizedValidationInput, NormalizedValidationLine } from "./normalize-input.ts";
import { canonicalizeCartPricingPayloadV2 } from "./cart-pricing-contract.ts";
import { normalizeConfig } from "./config-normalization.ts";
import { signHex } from "./hmac-sha256.ts";

const SECRET = "validation-unit-secret";
const ADJ = "gid://shopify/ProductVariant/999";
const PRODUCT = "gid://shopify/Product/1";
const VARIANT = "gid://shopify/ProductVariant/2";
const INSTALL = "inst-1";

const SHOP = (mode: string, over: Record<string, unknown> = {}) => ({
  schema: 1, mode, enabled: true, allowLegacyV1: false,
  adjustmentVariantGid: ADJ, installBinding: INSTALL, policyRevision: 7, ...over,
});
const PRODUCT_POLICY = { schema: 1, required: true, profileRef: "prof_LNY01", profileRevision: 12, active: true, policyRevision: 7 };

function v2Payload(over: Record<string, unknown> = {}) {
  const n = normalizeConfig({ quantity: 100, optionValueIds: ["a"], decorationMethod: "SCREEN_PRINT" });
  if (!n.ok) throw new Error("fixture");
  const p = {
    v: 2, installBinding: INSTALL, productGid: PRODUCT, variantGid: VARIANT, quantity: 100, currency: "USD",
    baseUnitPriceCents: 137, perUnitSurchargeCents: 0, flatSurchargeCents: 4500, lineTotalCents: 137 * 100 + 4500,
    adjustmentVariantGid: ADJ, profileRef: "prof_LNY01", profileRevision: 12, policyRevision: 7,
    configDigest: n.digest, quoteId: "q-1", issuedAtServer: 1, ...over,
  };
  return { payload: p, configJson: n.canonicalJson, signature: signHex(SECRET, canonicalizeCartPricingPayloadV2(p as never)) };
}

const MONEY = (perUnitCents: number, subtotalCents: number, currency = "USD") => ({
  amountPerQuantityCents: perUnitCents,
  subtotalCents,
  currency,
});

function line(over: Partial<NormalizedValidationLine> = {}): NormalizedValidationLine {
  return {
    id: "gid://shopify/CartLine/1",
    quantity: 100,
    isProductVariant: true,
    variantGid: VARIANT,
    productGid: PRODUCT,
    productPolicyJson: PRODUCT_POLICY,
    hasSellingPlan: false,
    attrs: { version: null, payload: null, signature: null, config: null },
    money: MONEY(182, 18200),
    parentLineId: null,
    ...over,
  };
}

function v2Line(over: Partial<NormalizedValidationLine> = {}, payloadOver: Record<string, unknown> = {}): NormalizedValidationLine {
  const q = v2Payload(payloadOver);
  return line({
    attrs: { version: "2", payload: JSON.stringify(q.payload), signature: q.signature, config: q.configJson },
    money: MONEY(182, q.payload.lineTotalCents),
    ...over,
  });
}

function input(lines: NormalizedValidationLine[], shopPolicyJson: unknown, buyerStep = "CHECKOUT_INTERACTION"): NormalizedValidationInput {
  return { buyerStep, shopPolicyJson, lines };
}

const codes = (errs: ReturnType<typeof runValidation>) => errs.map((e) => e.code).sort();
const messages = (errs: ReturnType<typeof runValidation>) => errs.map((e) => e.message);
const UNAVAILABLE = "Dynamic pricing is temporarily unavailable. Please refresh the page or contact us.";

// ===========================================================================
// §1 / §4 — activation readiness
// ===========================================================================

test("§4 activationReadiness(): NOT ready while effective-price runtime semantics are unverified", () => {
  const r = activationReadiness();
  assert.equal(r.ready, false);
  if (!r.ready) assert.equal(r.reason, "effective_price_runtime_unverified");
});

test("§1 a fully valid signed v2 enforced quote is BLOCKED at checkout while price verification is disabled (pilot)", () => {
  const r = runValidation(input([v2Line()], SHOP("pilot"), "CHECKOUT_INTERACTION"), SECRET);
  assert.deepEqual(codes(r), ["not_activation_ready"]);
  assert.deepEqual(messages(r), [UNAVAILABLE]);
});

test("§1 a fully valid signed v2 enforced quote is BLOCKED at checkout while price verification is disabled (universal)", () => {
  const r = runValidation(input([v2Line()], SHOP("universal"), "CHECKOUT_INTERACTION"), SECRET);
  assert.deepEqual(codes(r), ["not_activation_ready"]);
});

test("§1 unmarked pilot product (no policy metafield) remains ALLOWED while not ready", () => {
  assert.deepEqual(runValidation(input([line({ productPolicyJson: null })], SHOP("pilot")), SECRET), []);
});

test("§1 ordinary product under `disabled` policy remains ALLOWED while not ready", () => {
  assert.deepEqual(runValidation(input([v2Line()], SHOP("disabled")), SECRET), []);
});

test("§1 direct adjustment-variant addition is BLOCKED under every policy, even while not ready", () => {
  for (const mode of ["disabled", "pilot", "universal", "maintenance"]) {
    const adj = line({ id: "adj", variantGid: ADJ, productGid: "gid://shopify/Product/adj", productPolicyJson: null });
    assert.ok(codes(runValidation(input([adj], SHOP(mode)), SECRET)).includes("direct_adjustment"), mode);
  }
});

test("§1 the readiness gate is in the EXPORTED path (cart interaction proceeds, checkout is blocked)", () => {
  const q = v2Payload();
  const result = cartValidationsGenerateRun({
    buyerJourney: { step: "CHECKOUT_INTERACTION" },
    shop: { enforcementPolicy: { jsonValue: SHOP("pilot") } },
    cart: {
      lines: [
        {
          id: VARIANT, quantity: 100,
          cost: { amountPerQuantity: { amount: "1.82" }, subtotalAmount: { amount: "182.00", currencyCode: "USD" } },
          sellingPlanAllocation: null,
          merchandise: { __typename: "ProductVariant", id: VARIANT, product: { id: PRODUCT, pricingPolicy: { jsonValue: PRODUCT_POLICY } } },
          version: { value: "2" }, payload: { value: JSON.stringify(q.payload) }, signature: { value: q.signature }, config: { value: q.configJson },
          parentRelationship: null,
        },
      ],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const errs = result.operations[0]!.validationAdd!.errors;
  assert.equal(errs.length, 1);
  assert.equal(errs[0]!.message, UNAVAILABLE);
  assert.equal(errs[0]!.target, "$.cart");
});

test("§1 a valid signed quote is allowed during cart interaction so the Transform can be observed", () => {
  assert.deepEqual(runValidation(input([v2Line()], SHOP("pilot"), "CART_INTERACTION"), SECRET), []);
});

// ===========================================================================
// Shop-policy modes (unchanged behaviour)
// ===========================================================================

test("missing shop policy → one global $.cart error when the cart has an ordinary ProductVariant", () => {
  assert.deepEqual(codes(runValidation(input([line()], null), SECRET)), ["shop_policy_missing_or_malformed"]);
});

test("malformed shop policy blocks (unknown mode / missing field / unknown key)", () => {
  for (const bad of [{ mode: "legacy" }, { schema: 1, mode: "pilot" }, "x", { ...SHOP("pilot"), attackerField: 1 }]) {
    assert.deepEqual(codes(runValidation(input([line()], bad), SECRET)), ["shop_policy_missing_or_malformed"]);
  }
});

test("kill switch (enabled:false) behaves as disabled — ordinary product allowed, direct-adjustment blocked", () => {
  assert.deepEqual(runValidation(input([v2Line()], SHOP("universal", { enabled: false })), SECRET), []);
  const adj = line({ id: "adj", variantGid: ADJ, productPolicyJson: null });
  assert.ok(codes(runValidation(input([adj], SHOP("universal", { enabled: false })), SECRET)).includes("direct_adjustment"));
});

test("maintenance → one global unavailable error for ordinary ProductVariant lines, no native fallback", () => {
  const r = runValidation(input([v2Line(), v2Line({ id: "l2" })], SHOP("maintenance")), SECRET);
  assert.deepEqual(codes(r), ["maintenance_block"]);
  assert.deepEqual(messages(r), [UNAVAILABLE]);
});

test("pilot → a PRESENT but malformed product policy on an enforced product blocks", () => {
  assert.deepEqual(codes(runValidation(input([v2Line({ productPolicyJson: { mode: "nonsense" } })], SHOP("pilot")), SECRET)), ["product_policy_missing_or_malformed"]);
});

test("pilot → an inactive product policy blocks", () => {
  assert.deepEqual(codes(runValidation(input([v2Line({ productPolicyJson: { ...PRODUCT_POLICY, active: false } })], SHOP("pilot")), SECRET)), ["product_policy_inactive"]);
});

test("universal → missing product policy blocks", () => {
  assert.deepEqual(codes(runValidation(input([v2Line({ productPolicyJson: null })], SHOP("universal")), SECRET)), ["product_policy_missing_or_malformed"]);
});

test("an enforced product on a selling plan is blocked before the readiness gate, distinct message", () => {
  const r = runValidation(input([v2Line({ hasSellingPlan: true })], SHOP("universal")), SECRET);
  assert.deepEqual(codes(r), ["selling_plan_unsupported"]);
  assert.deepEqual(messages(r), ["This product can’t be purchased on a subscription. Please configure it as a one-time order."]);
});

// ===========================================================================
// §2 — complete authoritative parent resolution for components
// ===========================================================================

function componentSetup(payloadOver: Record<string, unknown> = {}) {
  const q = v2Payload({ perUnitSurchargeCents: 0, flatSurchargeCents: 4500, ...payloadOver });
  const parent = line({
    id: "parent-1",
    attrs: { version: "2", payload: JSON.stringify(q.payload), signature: q.signature, config: q.configJson },
    money: MONEY(137, q.payload.lineTotalCents),
    parentLineId: null,
  });
  const baseChild = line({ id: "c-base", parentLineId: "parent-1", variantGid: VARIANT, productGid: PRODUCT, productPolicyJson: null, quantity: 100, money: MONEY(137, 13700) });
  const flatChild = line({ id: "c-flat", parentLineId: "parent-1", variantGid: ADJ, productGid: "gid://shopify/Product/adj", productPolicyJson: null, quantity: 1, money: MONEY(4500, 4500) });
  return { parent, baseChild, flatChild, payload: q.payload };
}

test("§2 a legitimate expanded component set passes cart interaction while the runtime shape is being observed", () => {
  const { parent, baseChild, flatChild } = componentSetup();
  const r = runValidation(input([parent, baseChild, flatChild], SHOP("universal"), "CART_INTERACTION"), SECRET);
  assert.deepEqual(codes(r), []);
});

test("§2 a component whose parent id does NOT resolve to a complete top-level line fails closed", () => {
  const { flatChild } = componentSetup();
  const orphan = { ...flatChild, parentLineId: "does-not-exist" };
  assert.ok(codes(runValidation(input([orphan], SHOP("universal")), SECRET)).includes("orphan_component"));
});

test("§2 a shallow / unsigned resolved parent cannot authenticate a component", () => {
  const { flatChild } = componentSetup();
  const unsignedParent = line({ id: "parent-1", attrs: { version: null, payload: null, signature: null, config: null }, parentLineId: null });
  assert.ok(codes(runValidation(input([unsignedParent, flatChild], SHOP("universal")), SECRET)).includes("orphan_component"));
});

// The full 8-field quote-mismatch matrix, exercised through the CLOSEST REACHABLE
// production path — the component loop's authoritative-parent revalidation
// (`validateEnforcedQuote(parent)`), which runs regardless of activation readiness.
// (The verification primitive itself is also exhaustively covered by
// verify-payload-v2.test.ts + the drift.test.ts golden vectors.)
test("§2 a signed parent quote with a wrong product / variant / quantity / currency / profileRevision / policyRevision / adjustmentVariantGid / installBinding → component blocked", () => {
  for (const [name, over] of [
    ["product", { productGid: "gid://shopify/Product/other" }],
    ["variant", { variantGid: "gid://shopify/ProductVariant/other" }],
    ["quantity", { quantity: 200, lineTotalCents: 137 * 200 + 4500 }],
    ["currency", { currency: "EUR" }],
    ["profileRevision", { profileRevision: 11 }],
    ["policyRevision", { policyRevision: 6 }],
    ["adjustmentVariantGid", { adjustmentVariantGid: "gid://shopify/ProductVariant/xxx" }],
    ["installBinding", { installBinding: "someone-elses-install" }],
  ] as const) {
    const { parent, flatChild } = componentSetup(over);
    const r = runValidation(input([parent, flatChild], SHOP("universal")), SECRET);
    assert.ok(codes(r).includes("orphan_component"), name);
  }
});

test("§2 config-digest tampering on the parent (attribute JSON altered) → component blocked", () => {
  const { parent, flatChild } = componentSetup();
  const tampered = { ...parent, attrs: { ...parent.attrs, config: JSON.stringify({ ...JSON.parse(parent.attrs.config!), optionValueIds: ["z"] }) } };
  assert.ok(codes(runValidation(input([tampered, flatChild], SHOP("universal")), SECRET)).includes("orphan_component"));
});

test("§3 (post-add quantity edit): a component whose parent's cart quantity ≠ its signed quantity is blocked", () => {
  const { parent, baseChild, flatChild } = componentSetup();
  const edited = { ...parent, quantity: 101 }; // customer bumped the cart quantity after add
  assert.ok(codes(runValidation(input([edited, baseChild, flatChild], SHOP("universal")), SECRET)).includes("orphan_component"));
});

// ===========================================================================
// §3 — component multiset integrity (reject path, always active)
// ===========================================================================

test("§3 missing component is blocked", () => {
  const { parent, baseChild } = componentSetup(); // flat surcharge exists in payload but only base child present
  assert.ok(codes(runValidation(input([parent, baseChild], SHOP("universal")), SECRET)).includes("component_forgery"));
});

test("§3 extra / duplicate component is blocked", () => {
  const { parent, baseChild, flatChild } = componentSetup();
  const dup = { ...flatChild, id: "c-flat-2" };
  assert.ok(codes(runValidation(input([parent, baseChild, flatChild, dup], SHOP("universal")), SECRET)).includes("component_forgery"));
});

test("§3 altered component quantity is blocked", () => {
  const { parent, baseChild, flatChild } = componentSetup();
  const badBase = { ...baseChild, quantity: 99 };
  assert.ok(codes(runValidation(input([parent, badBase, flatChild], SHOP("universal")), SECRET)).includes("component_forgery"));
});

test("§3 altered component cents is blocked", () => {
  const { parent, baseChild, flatChild } = componentSetup();
  const badFlat = { ...flatChild, money: MONEY(1, 1) };
  assert.ok(codes(runValidation(input([parent, baseChild, badFlat], SHOP("universal")), SECRET)).includes("component_forgery"));
});

test("§3 component in the wrong currency is blocked", () => {
  const { parent, baseChild, flatChild } = componentSetup();
  const eurFlat = { ...flatChild, money: MONEY(4500, 4500, "EUR") };
  assert.ok(codes(runValidation(input([parent, baseChild, eurFlat], SHOP("universal")), SECRET)).includes("component_forgery"));
});

test("§3 component with a zero / negative / unsafe quantity is blocked", () => {
  for (const q of [0, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    const { parent, baseChild, flatChild } = componentSetup();
    const bad = { ...flatChild, quantity: q };
    assert.ok(codes(runValidation(input([parent, baseChild, bad], SHOP("universal")), SECRET)).includes("component_forgery"), String(q));
  }
});

test("§3 an adjustment component naming a variant the parent quote does NOT specify is blocked", () => {
  const { parent, baseChild } = componentSetup();
  const wrongAdj = line({ id: "c-x", parentLineId: "parent-1", variantGid: "gid://shopify/ProductVariant/xxx", productPolicyJson: null, quantity: 1, money: MONEY(4500, 4500) });
  // wrongAdj isn't the adjustment variant per the shop policy, so it also breaks the multiset
  assert.ok(codes(runValidation(input([parent, baseChild, wrongAdj], SHOP("universal")), SECRET)).includes("component_forgery"));
});

test("§3 multiset comparison is order-independent (components reversed still validate cleanly at the component level)", () => {
  const { parent, baseChild, flatChild } = componentSetup();
  const r = runValidation(input([flatChild, baseChild, parent], SHOP("universal")), SECRET);
  assert.ok(codes(r).includes("not_activation_ready")); // readiness still blocks checkout; component order adds no integrity error
  assert.ok(!codes(r).includes("component_forgery"));
});

test("§3 a cart discount does NOT cause a false component mismatch — component amounts come from amountPerQuantity (pre-discount)", () => {
  // The query never fetches a discounted line total; component per-unit cents are
  // `amountPerQuantity` (Shopify: the unit price before discounts). A discount cannot
  // change them, so the multiset still matches exactly.
  const { parent, baseChild, flatChild } = componentSetup();
  const r = runValidation(input([parent, baseChild, flatChild], SHOP("universal")), SECRET);
  assert.ok(!codes(r).includes("component_forgery") && !codes(r).includes("effective_price_mismatch"));
});

// ===========================================================================
// v1 / expired / malformed / modified v2 (all rejected for enforced)
// ===========================================================================

test("v1 quote is rejected for an enforced product (blocked, generic message)", () => {
  const r = runValidation(input([v2Line({ attrs: { version: "1", payload: "{}", signature: "x", config: "{}" } })], SHOP("universal")), SECRET);
  // readiness gate fires first for an enforced line — either way it is BLOCKED
  assert.ok(r.length >= 1);
  assert.ok(codes(r).every((c) => c === "not_activation_ready" || c === "v1_rejected"));
});

test("malformed / oversized v2 attributes on an enforced line are blocked", () => {
  const l = v2Line();
  l.attrs.payload = "x".repeat(5000);
  assert.ok(runValidation(input([l], SHOP("universal")), SECRET).length >= 1);
});

// ===========================================================================
// Error shaping: bounded / deterministic / deduped / $.cart / message safety
// ===========================================================================

test("errors are bounded (≤5), deterministic, deduplicated, all target $.cart", () => {
  const lines = Array.from({ length: 12 }, (_, i) => v2Line({ id: `gid://shopify/CartLine/${i}` }));
  const r = runValidation(input(lines, SHOP("universal"), "CHECKOUT_INTERACTION"), SECRET);
  assert.ok(r.length >= 1 && r.length <= 5);
  assert.deepEqual(r, [...r].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)));
  assert.equal(new Set(r.map((e) => e.message)).size, r.length);

  const result = cartValidationsGenerateRun({
    buyerJourney: { step: "CHECKOUT_INTERACTION" },
    shop: { enforcementPolicy: { jsonValue: SHOP("universal") } },
    cart: {
      lines: lines.map((l) => ({
        id: l.id, quantity: l.quantity,
        cost: { amountPerQuantity: { amount: "1.82" }, subtotalAmount: { amount: "182.00", currencyCode: "USD" } },
        sellingPlanAllocation: null,
        merchandise: { __typename: "ProductVariant", id: VARIANT, product: { id: PRODUCT, pricingPolicy: { jsonValue: PRODUCT_POLICY } } },
        version: null, payload: null, signature: null, config: null, parentRelationship: null,
      })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  assert.ok(result.operations[0]!.validationAdd!.errors.every((e) => e.target === "$.cart"));
});

test("customer messages contain no reject codes, signatures, payloads, secrets, GIDs, or internal ids", () => {
  const samples = [
    runValidation(input([line()], null), SECRET),
    runValidation(input([v2Line()], SHOP("pilot")), SECRET),
    runValidation(input([v2Line({ hasSellingPlan: true })], SHOP("universal")), SECRET),
    runValidation(input([line({ variantGid: ADJ, productPolicyJson: null })], SHOP("universal")), SECRET),
    runValidation(input([v2Line()], SHOP("maintenance")), SECRET),
    (() => { const { flatChild } = componentSetup(); return runValidation(input([{ ...flatChild, parentLineId: "nope" }], SHOP("universal")), SECRET); })(),
  ];
  for (const errs of samples) {
    for (const e of errs) {
      assert.ok(!/gid:\/\/|sha256:|_imprintid_|profile_revision|install_mismatch|config_digest|[0-9a-f]{40}/i.test(e.message), e.message);
      assert.ok(!e.message.includes(e.code), e.message);
      assert.ok(!e.message.includes(SECRET));
    }
  }
});

// ===========================================================================
// Source guards — no permissive catch, readiness in the exported path
// ===========================================================================

const SRC = readFileSync(new URL("./cart_validations_generate_run.ts", import.meta.url), "utf8");

test("no permissive catch branch: the Function source has no try/catch that could swallow a failure into a pass", () => {
  assert.ok(!/\bcatch\b/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")), "no catch in the validation run path");
});

test("the exported run path contains the activation-readiness guard", () => {
  assert.ok(/activationReadiness\(\)/.test(SRC));
  assert.ok(/input\.buyerStep\s*===\s*"CART_INTERACTION"[\s\S]*?return finalize\(out\)/.test(SRC), "readiness gate permits cart observation without an extra HMAC pass");
  assert.ok(/if \(!readiness\.ready\)[\s\S]*?not_activation_ready/.test(SRC), "readiness gate blocks checkout");
});

test("buyerJourney.step is normalized and available (empty cart → no errors at every step)", () => {
  for (const step of ["CART_INTERACTION", "CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"]) {
    const r = cartValidationsGenerateRun({
      buyerJourney: { step },
      shop: { enforcementPolicy: { jsonValue: SHOP("universal") } },
      cart: { lines: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    assert.deepEqual(r.operations[0]!.validationAdd!.errors, [], step);
  }
});

test("GraphQL input query complexity stays within budget: parentRelationship subtree is only { parent { id } }", () => {
  const q = readFileSync(new URL("./cart_validations_generate_run.graphql", import.meta.url), "utf8");
  const parentBlock = q.slice(q.indexOf("parentRelationship"));
  assert.ok(/parentRelationship\s*\{\s*parent\s*\{\s*id\s*\}\s*\}/.test(parentBlock), "parent subtree is shallow id-only");
  assert.ok(!/parent\s*\{[\s\S]*?(merchandise|attribute|cost|metafield)/.test(parentBlock), "no deep parent fields");
});
