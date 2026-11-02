import { test, after } from "node:test";
import assert from "node:assert/strict";
import { applyScopePlan, buildScopePlan, checkScopeContract, rollbackScope, type ScopeManifest } from "../../app/lib/catalog/pilot-scope.ts";
import { buildProductPolicyValue, canonicalPolicyJson } from "../../app/lib/catalog/policy-value.ts";
import { prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride, FakeWritePort, ENFORCEMENT_DISABLED } from "./helpers.ts";

/**
 * Pilot scoping: edit every product's policy EXCEPT the named ones, compare-and-set, with a
 * manifest and rollback. Refuses while shop enforcement is enabled.
 */

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

const PILOT_ENABLED = { ...ENFORCEMENT_DISABLED, mode: "pilot", enabled: true, policyRevision: 11 };
const policy = (profileId: string, revision: number, flags: { required?: boolean; active?: boolean } = {}) =>
  canonicalPolicyJson(buildProductPolicyValue({ profileId, profileRevision: revision, policyRevision: 1, ...flags }));

async function setup(n = 4) {
  const shop = makeShopDomain("scope");
  shops.push(shop);
  const storeId = await seedStore(shop, "USD");
  const port = new FakeWritePort();
  const items: Array<{ gid: string; profileId: string; revision: number }> = [];
  for (let i = 0; i < n; i++) {
    const profile = await seedProfile(storeId);
    const p = await seedCatalogProduct(storeId, { gid: `gid://shopify/Product/${9700 + i}` });
    await seedOverride(storeId, p.shopifyProductId, profile.id);
    port.seedExisting(p.shopifyProductId, policy(profile.id, profile.revision));
    items.push({ gid: p.shopifyProductId, profileId: profile.id, revision: profile.revision });
  }
  return { shop, storeId, port, items, keep: [items[0].gid] };
}

const setCalls = (port: FakeWritePort) => port.calls.filter((c) => c.op !== "read").length;
const args = (s: Awaited<ReturnType<typeof setup>>, mode?: "inactive" | "unrequired") => ({ prisma, port: s.port, storeId: s.storeId, shop: s.shop, keep: s.keep, mode });

test("plan: every product except the kept one is listed, the kept one must be active and required, and nothing is written", async () => {
  const s = await setup(4);
  const plan = await buildScopePlan({ ...args(s), shopPolicyJson: PILOT_ENABLED });
  assert.equal(plan.totals.change, 3);
  assert.equal(plan.totals.keep, 1);
  assert.equal(plan.totals.blocked, 0);
  assert.deepEqual(plan.kept.map((k) => k.productGid), s.keep);
  assert.ok(!plan.rows.some((r) => r.productGid === s.keep[0]));
  assert.ok(plan.rows.every((r) => JSON.parse(r.afterJson).active === false && JSON.parse(r.afterJson).required === true), "default mode deactivates (fail-closed)");
  assert.deepEqual(checkScopeContract(plan, { change: 3, keep: s.keep, blocked: 0 }), []);
  assert.equal(plan.enforcement.applyBlocked, true, "reported, but planning is still allowed");
  assert.equal(setCalls(s.port), 0);
  assert.equal((await buildScopePlan({ ...args(s), shopPolicyJson: PILOT_ENABLED })).hash, plan.hash);
  const unrequired = await buildScopePlan({ ...args(s, "unrequired"), shopPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(unrequired.rows.every((r) => JSON.parse(r.afterJson).required === false && JSON.parse(r.afterJson).active === true));
  assert.notEqual(unrequired.hash, plan.hash, "the mode is part of the hash");
});

test("apply is refused while enforcement is enabled: no manifest and no Shopify call", async () => {
  const s = await setup(3);
  const plan = await buildScopePlan({ ...args(s), shopPolicyJson: ENFORCEMENT_DISABLED });
  s.port.calls.length = 0;
  const r = await applyScopePlan({ ...args(s), approvedHash: plan.hash, readShopPolicyJson: async () => PILOT_ENABLED, onManifest: async () => assert.fail("no manifest for a refused run") });
  assert.equal(r.state, "refused");
  assert.match(r.refusedBecause?.[0] ?? "", /ENABLED/);
  assert.equal(s.port.calls.length, 0);
  const malformed = await applyScopePlan({ ...args(s), approvedHash: plan.hash, readShopPolicyJson: async () => ({ nope: 1 }), onManifest: async () => assert.fail("no manifest") });
  assert.equal(malformed.state, "refused");
});

test("apply edits exactly the planned products, leaves the kept one alone, and rollback restores them", async () => {
  const s = await setup(4);
  const plan = await buildScopePlan({ ...args(s), shopPolicyJson: ENFORCEMENT_DISABLED });
  const states: string[] = [];
  let manifest: ScopeManifest | undefined;
  const r = await applyScopePlan({ ...args(s), approvedHash: plan.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED, onManifest: async (m) => { states.push(m.state); manifest = JSON.parse(JSON.stringify(m)); } });
  assert.equal(r.state, "completed");
  assert.equal(r.changed, 3);
  assert.equal(states[0], "planned", "manifest existed before the first Shopify write");
  for (const it of s.items.slice(1)) assert.equal(s.port.current(it.gid), policy(it.profileId, it.revision, { active: false }));
  assert.equal(s.port.current(s.keep[0]), policy(s.items[0].profileId, s.items[0].revision), "the kept product is untouched");

  const keptDigestBefore = s.port.currentDigest(s.keep[0]);
  const rb = await rollbackScope({ port: s.port, storeId: s.storeId, shop: s.shop, manifest: JSON.parse(JSON.stringify(r.manifest)), onManifest: async () => {} });
  assert.equal(rb.restored, 3);
  assert.deepEqual(rb.skipped, []);
  for (const it of s.items.slice(1)) assert.equal(s.port.current(it.gid), policy(it.profileId, it.revision));
  assert.equal(s.port.currentDigest(s.keep[0]), keptDigestBefore);
  assert.ok(manifest);
});

test("a stale hash, or a policy that is not the expected active one, refuses", async () => {
  const s = await setup(3);
  const plan = await buildScopePlan({ ...args(s), shopPolicyJson: ENFORCEMENT_DISABLED });
  s.port.externalWrite(s.items[1].gid, policy(s.items[1].profileId, s.items[1].revision, { active: false }));
  const stale = await applyScopePlan({ ...args(s), approvedHash: plan.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED, onManifest: async () => assert.fail("no manifest") });
  assert.equal(stale.state, "refused");
  const fresh = await buildScopePlan({ ...args(s), shopPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(fresh.totals.blockedByReason.policy_differs, 1);
  const blocked = await applyScopePlan({ ...args(s), approvedHash: fresh.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED, onManifest: async () => assert.fail("no manifest") });
  assert.equal(blocked.state, "refused");
  assert.equal(setCalls(s.port), 0);

  const notActive = await setup(2);
  notActive.port.externalWrite(notActive.keep[0], policy(notActive.items[0].profileId, notActive.items[0].revision, { active: false }));
  const p2 = await buildScopePlan({ ...args(notActive), shopPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(p2.totals.blockedByReason.keep_policy_not_active_and_required, 1, "the kept product must currently be enforced");
});

test("a metafield changed after the plan is a conflict: nothing in the batch is written and the run stops", async () => {
  const s = await setup(4);
  const plan = await buildScopePlan({ ...args(s), shopPolicyJson: ENFORCEMENT_DISABLED });
  let first = true;
  const r = await applyScopePlan({
    ...args(s), approvedHash: plan.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED,
    onManifest: async () => { if (first) { first = false; s.port.externalWrite(plan.rows[1].productGid, policy(plan.rows[1].profileId, plan.rows[1].profileRevision)); } },
  });
  assert.equal(r.state, "aborted");
  assert.match(r.abortedBecause?.[0] ?? "", /changed since the plan/);
  assert.equal(setCalls(s.port), 0, "no write happened for the batch");
  for (const row of plan.rows) assert.equal(s.port.current(row.productGid), row.beforeJson);
});

test("a rejected write stops the run, records it, and rollback restores the ones that landed", async () => {
  const s = await setup(5);
  const plan = await buildScopePlan({ ...args(s), shopPolicyJson: ENFORCEMENT_DISABLED });
  s.port.failSet.set(plan.rows[2].productGid, [{ ok: false, retryable: false, code: "USER_ERROR", message: "rejected by Shopify" }]);
  const r = await applyScopePlan({ ...args(s), approvedHash: plan.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED, onManifest: async () => {} });
  assert.equal(r.state, "aborted");
  const statuses = r.manifest!.entries.map((e) => e.status);
  assert.ok(statuses.includes("failed") && statuses.includes("done"));
  const rb = await rollbackScope({ port: s.port, storeId: s.storeId, shop: s.shop, manifest: JSON.parse(JSON.stringify(r.manifest)), onManifest: async () => {} });
  assert.equal(rb.restored, statuses.filter((x) => x === "done").length);
  for (const row of plan.rows) assert.equal(s.port.current(row.productGid), row.beforeJson, "everything is back as planned");
});

test("rollback leaves a metafield that someone changed after the run alone", async () => {
  const s = await setup(3);
  const plan = await buildScopePlan({ ...args(s), shopPolicyJson: ENFORCEMENT_DISABLED });
  const r = await applyScopePlan({ ...args(s), approvedHash: plan.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED, onManifest: async () => {} });
  const touched = plan.rows[0];
  s.port.externalWrite(touched.productGid, policy(touched.profileId, touched.profileRevision, { required: false }));
  const rb = await rollbackScope({ port: s.port, storeId: s.storeId, shop: s.shop, manifest: JSON.parse(JSON.stringify(r.manifest)), onManifest: async () => {} });
  assert.equal(rb.restored, 1);
  assert.equal(rb.skipped.length, 1);
  assert.equal(s.port.current(touched.productGid), policy(touched.profileId, touched.profileRevision, { required: false }), "the third-party value stays");
});
