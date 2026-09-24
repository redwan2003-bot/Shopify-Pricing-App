import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceFromPolicy, planEnforcementChange, readEnforcement, writeEnforcement } from "./settings.ts";
import type { ShopEnforcementPolicy } from "../pricing-api/policy-metafields.ts";

const base: ShopEnforcementPolicy = {
  schema: 1,
  mode: "pilot",
  enabled: false,
  allowLegacyV1: false,
  adjustmentVariantGid: "gid://shopify/ProductVariant/42",
  installBinding: "inst_x",
  policyRevision: 3,
};
const ready = { setupComplete: true, canSignQuotes: true };

test("the current choice is derived from mode and the on/off flag", () => {
  assert.equal(choiceFromPolicy(base), "off", "a pilot policy that is switched off reads as off");
  assert.equal(choiceFromPolicy({ ...base, enabled: true }), "pilot");
  assert.equal(choiceFromPolicy({ ...base, enabled: true, mode: "disabled" }), "off");
  assert.equal(choiceFromPolicy({ ...base, enabled: true, mode: "maintenance" }), "maintenance");
});

test("turning pilot on bumps the revision and keeps the binding and adjustment variant", () => {
  const plan = planEnforcementChange(base, "pilot", { confirmUniversal: false }, ready);
  assert.ok(plan.ok && !plan.unchanged);
  if (plan.ok && !plan.unchanged) {
    assert.equal(plan.next.mode, "pilot");
    assert.equal(plan.next.enabled, true);
    assert.equal(plan.next.policyRevision, 4);
    assert.equal(plan.next.installBinding, "inst_x");
    assert.equal(plan.next.adjustmentVariantGid, base.adjustmentVariantGid);
  }
});

test("choosing the current setting writes nothing", () => {
  const plan = planEnforcementChange({ ...base, enabled: true }, "pilot", { confirmUniversal: false }, ready);
  assert.deepEqual(plan, { ok: true, unchanged: true });
});

test("pricing cannot be switched on before setup is finished or while quotes can't be signed", () => {
  const notSetUp = planEnforcementChange(base, "pilot", { confirmUniversal: false }, { setupComplete: false, canSignQuotes: true });
  assert.equal(notSetUp.ok, false);
  const noSigning = planEnforcementChange(base, "pilot", { confirmUniversal: false }, { setupComplete: true, canSignQuotes: false });
  assert.equal(noSigning.ok, false);
  assert.match(!noSigning.ok ? noSigning.message : "", /block checkout/);
});

test("off and maintenance are always allowed, even when signing is broken (they are the safety exits)", () => {
  const broken = { setupComplete: false, canSignQuotes: false };
  const on = { ...base, enabled: true };
  const off = planEnforcementChange(on, "off", { confirmUniversal: false }, broken);
  assert.ok(off.ok && !off.unchanged && off.next.enabled === false && off.next.mode === "disabled");
  const maint = planEnforcementChange(on, "maintenance", { confirmUniversal: false }, broken);
  assert.ok(maint.ok && !maint.unchanged && maint.next.mode === "maintenance" && maint.next.enabled === true);
});

test("universal requires explicit confirmation; unknown choices are refused", () => {
  assert.equal(planEnforcementChange(base, "universal", { confirmUniversal: false }, ready).ok, false);
  const yes = planEnforcementChange(base, "universal", { confirmUniversal: true }, ready);
  assert.ok(yes.ok && !yes.unchanged && yes.next.mode === "universal");
  assert.equal(planEnforcementChange(base, "everything", { confirmUniversal: true }, ready).ok, false);
});

function fakeAdmin(opts: { digest: string; policy: unknown; writeErrors?: { message: string; code?: string }[] }) {
  const writes: Record<string, unknown>[] = [];
  return {
    writes,
    admin: {
      async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
        if (query.includes("ImprintIdEnforcementRead")) {
          return { json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1", metafield: { jsonValue: opts.policy, compareDigest: opts.digest } } } }) };
        }
        writes.push((options!.variables!.metafields as Record<string, unknown>[])[0]);
        return { json: async () => ({ data: { metafieldsSet: { metafields: [{ id: "m" }], userErrors: opts.writeErrors ?? [] } } }) };
      },
    },
  };
}

test("the write is compare-and-set against the digest that was read, and round-trips through the parser", async () => {
  const { allowLegacyV1: _omit, ...stored } = base; // as stored in Shopify: the key is absent
  void _omit;
  const { admin, writes } = fakeAdmin({ digest: "digest-abc", policy: stored });
  const read = await readEnforcement(admin);
  assert.equal(read.compareDigest, "digest-abc");
  const plan = planEnforcementChange(read.policy!, "pilot", { confirmUniversal: false }, ready);
  assert.ok(plan.ok && !plan.unchanged);
  if (plan.ok && !plan.unchanged) assert.deepEqual(await writeEnforcement(admin, read, plan.next), { ok: true });
  assert.equal(writes[0].compareDigest, "digest-abc");
  const written = JSON.parse(writes[0].value as string);
  assert.equal("allowLegacyV1" in written, false, "not added when it was never set");
  const { parseShopEnforcementPolicy } = await import("../pricing-api/policy-metafields.ts");
  assert.ok(parseShopEnforcementPolicy(written), "what we write is a valid policy for the Functions");
});

test("a concurrent change is reported as a conflict, not applied", async () => {
  const { admin } = fakeAdmin({ digest: "d1", policy: base, writeErrors: [{ message: "digest mismatch", code: "PRESENT_OR_ABSENT_DIGEST_MISMATCH" }] });
  const read = await readEnforcement(admin);
  const r = await writeEnforcement(admin, read, { ...base, enabled: true, policyRevision: 4 });
  assert.deepEqual(r.ok, false);
  assert.equal(!r.ok && r.conflict, true);
});

test("every choice writes a policy both Functions accept, and the install-time default does too", async () => {
  const { parseShopEnforcementPolicy: validationParse } = await import("../../../extensions/imprintid-cart-validation/src/verify-payload-v2.ts");
  const { parseShopEnforcementPolicy: transformParse } = await import("../../../extensions/imprintid-cart-pricing/src/verify-payload-v2.ts");
  for (const choice of ["off", "pilot", "universal", "maintenance"]) {
    const { admin, writes } = fakeAdmin({ digest: "d", policy: { ...base, mode: choice === "pilot" ? "universal" : "pilot", enabled: true } });
    const read = await readEnforcement(admin);
    const plan = planEnforcementChange(read.policy!, choice, { confirmUniversal: true }, ready);
    assert.ok(plan.ok && !plan.unchanged, choice);
    if (plan.ok && !plan.unchanged) await writeEnforcement(admin, read, plan.next);
    const written = JSON.parse(writes[0].value as string);
    assert.ok(validationParse(written), `Validation Function accepts ${choice}`);
    assert.ok(transformParse(written), `Cart Transform accepts ${choice}`);
  }
  const installDefault = { schema: 1, mode: "pilot", enabled: false, adjustmentVariantGid: "gid://shopify/ProductVariant/1", installBinding: "inst_1", policyRevision: 1 };
  assert.ok(validationParse(installDefault) && transformParse(installDefault), "provisionShop's default policy");
});
