import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionShop, readProvisionState, provisionStatusFrom, VALIDATION_TITLE, ADJUSTMENT_TAGS } from "./provision-shop.ts";

/** A minimal stateful stand-in for a shop's Admin API, recording mutations in order. */
function fakeShop(initial: Partial<{
  policy: unknown;
  shopDef: boolean;
  productDef: boolean;
  transform: boolean;
  validation: { enabled: boolean } | null;
  adjustments: number;
  fail: string;
}> = {}) {
  const s = {
    policy: initial.policy ?? null,
    shopDef: initial.shopDef ?? false,
    productDef: initial.productDef ?? false,
    transform: initial.transform ?? false,
    validation: initial.validation ?? null,
    adjustments: Array.from({ length: initial.adjustments ?? 0 }, (_, i) => ({ id: `gid://shopify/Product/9${i}`, variantId: `gid://shopify/ProductVariant/9${i}` })),
  };
  const calls: string[] = [];
  let seq = 100;
  const admin = {
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      const v = options?.variables ?? {};
      const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "?";
      if (name !== "ImprintIdProvisionState") calls.push(name);
      if (initial.fail && name === initial.fail) {
        return { json: async () => ({ data: { [Object.keys(FIELD).find((k) => FIELD[k] === name)!]: { userErrors: [{ message: "boom" }] } } }) };
      }
      let data: Record<string, unknown> = {};
      switch (name) {
        case "ImprintIdProvisionState":
          data = {
            shop: { id: "gid://shopify/Shop/1", metafield: s.policy === null ? null : { jsonValue: s.policy } },
            shopDefinitions: { nodes: s.shopDef ? [{ id: "d1" }] : [] },
            productDefinitions: { nodes: s.productDef ? [{ id: "d2" }] : [] },
            shopifyFunctions: { nodes: [{ id: "fn-ct", apiType: "cart_transform" }, { id: "fn-val", apiType: "cart_checkout_validation" }] },
            cartTransforms: { nodes: s.transform ? [{ id: "ct1", functionId: "fn-ct" }] : [] },
            validations: { nodes: s.validation ? [{ id: "v1", title: VALIDATION_TITLE, enabled: s.validation.enabled }] : [] },
            adjustmentProducts: { nodes: s.adjustments.map((a) => ({ id: a.id, tags: ADJUSTMENT_TAGS, variants: { nodes: [{ id: a.variantId }] } })) },
          };
          break;
        case "ImprintIdDefinitionCreate": {
          const d = v.definition as { ownerType: string };
          if (d.ownerType === "SHOP") s.shopDef = true;
          else s.productDef = true;
          data = { metafieldDefinitionCreate: { createdDefinition: { id: `d${seq++}` }, userErrors: [] } };
          break;
        }
        case "ImprintIdAdjustmentCreate": {
          const id = seq++;
          s.adjustments.push({ id: `gid://shopify/Product/${id}`, variantId: `gid://shopify/ProductVariant/${id}` });
          data = { productCreate: { product: { id: `gid://shopify/Product/${id}`, variants: { nodes: [{ id: `gid://shopify/ProductVariant/${id}` }] } }, userErrors: [] } };
          break;
        }
        case "ImprintIdAdjustmentVariant":
          data = { productVariantsBulkUpdate: { productVariants: [{ id: "x" }], userErrors: [] } };
          break;
        case "ImprintIdPublications":
          data = { publications: { nodes: [{ id: "gid://shopify/Publication/online-store", name: "Online Store" }] } };
          break;
        case "ImprintIdAdjustmentPublish":
          data = { publishablePublish: { userErrors: [] } };
          break;
        case "ImprintIdPolicySet": {
          const mf = (v.metafields as { value: string }[])[0];
          s.policy = JSON.parse(mf.value);
          data = { metafieldsSet: { metafields: [{ id: "m1" }], userErrors: [] } };
          break;
        }
        case "ImprintIdCartTransformCreate":
          s.transform = true;
          data = { cartTransformCreate: { cartTransform: { id: "ct1" }, userErrors: [] } };
          break;
        case "ImprintIdValidationCreate":
          s.validation = { enabled: true };
          data = { validationCreate: { validation: { id: "v1" }, userErrors: [] } };
          break;
        case "ImprintIdValidationUpdate":
          s.validation = { enabled: true };
          data = { validationUpdate: { validation: { id: "v1" }, userErrors: [] } };
          break;
      }
      return { json: async () => ({ data }) };
    },
  };
  return { admin, state: s, calls };
}

const FIELD: Record<string, string> = {
  metafieldDefinitionCreate: "ImprintIdDefinitionCreate",
  productCreate: "ImprintIdAdjustmentCreate",
  publishablePublish: "ImprintIdAdjustmentPublish",
  metafieldsSet: "ImprintIdPolicySet",
  cartTransformCreate: "ImprintIdCartTransformCreate",
  validationCreate: "ImprintIdValidationCreate",
};

test("a fresh shop gets everything, with enforcement OFF and the policy written before the Validation", async () => {
  const { admin, state, calls } = fakeShop();
  const report = await provisionShop(admin);
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.changed, ["definitions", "adjustment_product", "shop_policy", "cart_transform", "validation"]);
  const policy = state.policy as { enabled: boolean; mode: string; adjustmentVariantGid: string; installBinding: string; policyRevision: number };
  assert.equal(policy.enabled, false, "never enforces on install");
  assert.equal(policy.adjustmentVariantGid, report.adjustmentVariantGid);
  assert.match(policy.installBinding, /^inst_/);
  assert.ok(calls.indexOf("ImprintIdPolicySet") < calls.indexOf("ImprintIdValidationCreate"), `order was ${calls.join(" > ")}`);
  assert.ok(calls.indexOf("ImprintIdAdjustmentCreate") < calls.indexOf("ImprintIdPolicySet"));
  assert.equal(provisionStatusFrom(await readProvisionState(admin)).complete, true);
});

test("running again changes nothing", async () => {
  const shop = fakeShop();
  await provisionShop(shop.admin);
  shop.calls.length = 0;
  const report = await provisionShop(shop.admin);
  assert.equal(report.ok, true);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(shop.calls, ["ImprintIdPublications", "ImprintIdAdjustmentPublish"], "publication repair is idempotent");
});

test("an existing enforced policy is left switched on (the demo store must not be turned off)", async () => {
  const existing = { schema: 1, mode: "pilot", enabled: true, adjustmentVariantGid: "gid://shopify/ProductVariant/90", installBinding: "dev-1", policyRevision: 1 };
  const { admin, state, calls } = fakeShop({ policy: existing, shopDef: true, productDef: true, transform: true, validation: { enabled: true }, adjustments: 1 });
  const report = await provisionShop(admin);
  assert.equal(report.ok, true);
  assert.deepEqual(calls, ["ImprintIdPublications", "ImprintIdAdjustmentPublish"]);
  assert.deepEqual(state.policy, existing);
});

test("a policy pointing at a deleted adjustment product is repointed and its revision bumped, enforcement untouched", async () => {
  const existing = { schema: 1, mode: "pilot", enabled: true, adjustmentVariantGid: "gid://shopify/ProductVariant/12345", installBinding: "dev-1", policyRevision: 3 };
  const { admin, state } = fakeShop({ policy: existing, shopDef: true, productDef: true, transform: true, validation: { enabled: true } });
  const report = await provisionShop(admin);
  assert.equal(report.ok, true);
  const p = state.policy as typeof existing;
  assert.equal(p.adjustmentVariantGid, report.adjustmentVariantGid);
  assert.equal(p.policyRevision, 4);
  assert.equal(p.enabled, true);
  assert.equal(p.installBinding, "dev-1");
});

test("provisioning clears legacy v1 authorization before v2 enforcement", async () => {
  const existing = {
    schema: 1,
    mode: "pilot",
    enabled: true,
    allowLegacyV1: true,
    adjustmentVariantGid: "gid://shopify/ProductVariant/90",
    installBinding: "dev-1",
    policyRevision: 3,
  };
  const { admin, state, calls } = fakeShop({
    policy: existing,
    shopDef: true,
    productDef: true,
    transform: true,
    validation: { enabled: true },
    adjustments: 1,
  });
  const report = await provisionShop(admin);
  assert.equal(report.ok, true);
  assert.deepEqual(calls, ["ImprintIdPublications", "ImprintIdAdjustmentPublish", "ImprintIdPolicySet"]);
  assert.deepEqual(state.policy, { ...existing, allowLegacyV1: false, policyRevision: 4 });
});

test("a malformed policy is replaced with a safe, disabled one", async () => {
  const { admin, state } = fakeShop({ policy: { nonsense: true } });
  const report = await provisionShop(admin);
  assert.equal(report.ok, true);
  assert.equal((state.policy as { enabled: boolean }).enabled, false);
});

test("if the policy write fails, the Validation is never activated", async () => {
  const { admin, state, calls } = fakeShop({ fail: "ImprintIdPolicySet" });
  const report = await provisionShop(admin);
  assert.equal(report.ok, false);
  assert.equal(report.failedStep, "shop_policy");
  assert.equal(state.validation, null);
  assert.ok(!calls.includes("ImprintIdValidationCreate"));
  assert.ok(!calls.includes("ImprintIdCartTransformCreate"));
});

test("a partial failure is finished on retry", async () => {
  const first = fakeShop({ fail: "ImprintIdCartTransformCreate" });
  assert.equal((await provisionShop(first.admin)).failedStep, "cart_transform");
  const status = provisionStatusFrom(await readProvisionState(first.admin));
  assert.deepEqual(status.missing, ["cart_transform", "validation"]);
});

test("a disabled Validation is re-enabled; duplicate adjustment products stop setup with a clear message", async () => {
  const policy = { schema: 1, mode: "pilot", enabled: false, adjustmentVariantGid: "gid://shopify/ProductVariant/90", installBinding: "x", policyRevision: 1 };
  const off = fakeShop({ policy, shopDef: true, productDef: true, transform: true, validation: { enabled: false }, adjustments: 1 });
  const r1 = await provisionShop(off.admin);
  assert.deepEqual(r1.changed, ["validation"]);
  assert.deepEqual(off.calls, ["ImprintIdPublications", "ImprintIdAdjustmentPublish", "ImprintIdValidationUpdate"]);

  const dup = fakeShop({ adjustments: 2 });
  const r2 = await provisionShop(dup.admin);
  assert.equal(r2.ok, false);
  assert.equal(r2.failedStep, "adjustment_product");
  assert.match(r2.error!, /more than one/);
});
