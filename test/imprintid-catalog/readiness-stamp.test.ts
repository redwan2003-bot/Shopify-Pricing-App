import { test, after } from "node:test";
import assert from "node:assert/strict";
import { applyReadinessPlan, buildReadinessPlan, checkReadinessContract, readOnlyPort, rollbackReadiness, type ReadinessManifest } from "../../app/lib/catalog/readiness-stamp.ts";
import { buildProductPolicyValue, canonicalPolicyJson } from "../../app/lib/catalog/policy-value.ts";
import { prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride, FakeWritePort, ENFORCEMENT_DISABLED } from "./helpers.ts";

/**
 * The readiness runner: it only ever drives the assignment processor over products whose
 * override and Shopify policy are already correct, and it must never run while shop
 * enforcement is enabled.
 */

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

const PILOT_ENABLED = { ...ENFORCEMENT_DISABLED, mode: "pilot", enabled: true, policyRevision: 9 };

async function setup(n = 3) {
  const shop = makeShopDomain("ready");
  shops.push(shop);
  const storeId = await seedStore(shop, "USD");
  const port = new FakeWritePort();
  const items: Array<{ id: string; gid: string; profileId: string }> = [];
  for (let i = 0; i < n; i++) {
    const profile = await seedProfile(storeId);
    const p = await seedCatalogProduct(storeId, { gid: `gid://shopify/Product/${9500 + i}` });
    await seedOverride(storeId, p.shopifyProductId, profile.id);
    port.seedExisting(p.shopifyProductId, canonicalPolicyJson(buildProductPolicyValue({ profileId: profile.id, profileRevision: profile.revision, policyRevision: 1 })));
    items.push({ id: p.id, gid: p.shopifyProductId, profileId: profile.id });
  }
  return { shop, storeId, port, items };
}

const cols = (id: string) =>
  prisma.catalogProduct.findUniqueOrThrow({
    where: { id },
    select: { coverageStatus: true, assignedProfileId: true, assignmentSource: true, enforcementReady: true, policySyncedAt: true, policyDigest: true },
  });
const jobCount = (storeId: string) => prisma.bulkAssignmentJob.count({ where: { storeId } });
const setCalls = (port: FakeWritePort) => port.calls.filter((c) => c.op !== "read").length;

test("plan makes no writes, lists every stampable row, and reports that apply is blocked while enforcement is enabled", async () => {
  const { shop, storeId, port, items } = await setup(3);
  const plan = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: PILOT_ENABLED });
  assert.equal(plan.totals.stamp, 3);
  assert.equal(plan.totals.blocked, 0);
  assert.equal(plan.enforcement.enabled, true);
  assert.equal(plan.enforcement.applyBlocked, true);
  assert.deepEqual(checkReadinessContract(plan, { stamp: 3, alreadyReady: 0, blocked: 0 }), []);
  assert.ok(plan.rows.every((r) => r.liveDigest === port.currentDigest(r.productGid)));
  assert.equal(setCalls(port), 0, "only reads against Shopify");
  assert.equal(await jobCount(storeId), 0, "plan created no job rows");
  for (const it of items) {
    const c = await cols(it.id);
    assert.equal(c.policySyncedAt, null);
    assert.equal(c.enforcementReady, false);
  }
  assert.equal((await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: PILOT_ENABLED })).hash, plan.hash, "deterministic");
});

test("apply is refused while enforcement is enabled: no manifest, no jobs, no Shopify calls, no column changes", async () => {
  const { shop, storeId, port, items } = await setup(2);
  const plan = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: PILOT_ENABLED });
  port.calls.length = 0;
  const result = await applyReadinessPlan({
    prisma, port, storeId, shop, approvedHash: plan.hash,
    readShopPolicyJson: async () => PILOT_ENABLED,
    onManifest: async () => assert.fail("a refused run must not write a manifest"),
  });
  assert.equal(result.state, "refused");
  assert.match(result.refusedBecause?.[0] ?? "", /ENABLED/);
  assert.equal(port.calls.length, 0);
  assert.equal(await jobCount(storeId), 0);
  assert.equal((await cols(items[0].id)).policySyncedAt, null);
});

test("an unreadable or malformed shop policy also refuses (fail closed)", async () => {
  const { shop, storeId, port } = await setup(1);
  const plan = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  const result = await applyReadinessPlan({
    prisma, port, storeId, shop, approvedHash: plan.hash,
    readShopPolicyJson: async () => ({ nonsense: true }),
    onManifest: async () => assert.fail("no manifest"),
  });
  assert.equal(result.state, "refused");
  assert.equal(await jobCount(storeId), 0);
});

test("with enforcement disabled, apply stamps exactly the planned rows through the processor and never writes to Shopify", async () => {
  const { shop, storeId, port, items } = await setup(3);
  const plan = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  const states: string[] = [];
  let manifest: ReadinessManifest | undefined;
  port.calls.length = 0;
  const result = await applyReadinessPlan({
    prisma, port, storeId, shop, approvedHash: plan.hash,
    readShopPolicyJson: async () => ENFORCEMENT_DISABLED,
    onManifest: async (m) => { states.push(m.state); manifest = JSON.parse(JSON.stringify(m)); },
  });
  assert.equal(result.state, "completed");
  assert.equal(result.stamped, 3);
  assert.equal(states[0], "planned", "the manifest existed before the first job");
  assert.equal(setCalls(port), 0, "no Shopify mutation of any kind");
  assert.equal(manifest!.shopifyWriteAttempts, 0);
  for (const it of items) {
    const c = await cols(it.id);
    assert.equal(c.enforcementReady, true);
    assert.ok(c.policySyncedAt);
    assert.equal(c.policyDigest, port.currentDigest(it.gid), "the digest is the live Shopify digest");
    assert.equal(c.assignedProfileId, it.profileId);
    assert.equal(c.coverageStatus, "assigned");
  }
  assert.equal(await jobCount(storeId), 3, "one processor job per product");
  const again = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(again.totals.stamp, 0);
  assert.equal(again.totals.alreadyReady, 3, "post-apply plan has no remaining changes");
});

test("a stale approved hash is refused, and a metafield that differs from the processor's policy blocks the plan", async () => {
  const { shop, storeId, port, items } = await setup(2);
  const plan = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  port.externalWrite(items[0].gid, canonicalPolicyJson(buildProductPolicyValue({ profileId: "someone-else", profileRevision: 1, policyRevision: 1 })));
  const stale = await applyReadinessPlan({ prisma, port, storeId, shop, approvedHash: plan.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED, onManifest: async () => assert.fail("no manifest") });
  assert.equal(stale.state, "refused");
  const fresh = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(fresh.totals.blockedByReason.policy_differs, 1);
  assert.ok(checkReadinessContract(fresh, { stamp: 2, alreadyReady: 0, blocked: 0 }).length > 0);
  const blockedRun = await applyReadinessPlan({ prisma, port, storeId, shop, approvedHash: fresh.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED, onManifest: async () => assert.fail("no manifest") });
  assert.equal(blockedRun.state, "refused");
  assert.equal((await cols(items[1].id)).policySyncedAt, null, "nothing was stamped");
});

test("enforcement switched on mid-run stops the run before the next job", async () => {
  const { shop, storeId, port, items } = await setup(3);
  const plan = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  let reads = 0;
  const result = await applyReadinessPlan({
    prisma, port, storeId, shop, approvedHash: plan.hash,
    readShopPolicyJson: async () => (++reads >= 3 ? PILOT_ENABLED : ENFORCEMENT_DISABLED),
    onManifest: async () => {},
  });
  assert.equal(result.state, "aborted");
  assert.equal(result.manifest!.entries.filter((e) => e.status === "done").length, 1);
  assert.equal(result.manifest!.entries.filter((e) => e.status === "skipped").length, 2);
  const stamped = (await Promise.all(items.map((i) => cols(i.id)))).filter((c) => c.policySyncedAt).length;
  assert.equal(stamped, 1);
});

test("a row or metafield that changed after the plan is a conflict: it is not touched and the run stops", async () => {
  const a = await setup(3);
  const planA = await buildReadinessPlan({ prisma, port: a.port, storeId: a.storeId, shop: a.shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  let first = true;
  const rowChanged = await applyReadinessPlan({
    prisma, port: a.port, storeId: a.storeId, shop: a.shop, approvedHash: planA.hash,
    readShopPolicyJson: async () => ENFORCEMENT_DISABLED,
    onManifest: async () => { if (first) { first = false; await prisma.catalogProduct.update({ where: { id: planA.rows[0].catalogProductId }, data: { coverageStatus: "invalid" } }); } },
  });
  assert.equal(rowChanged.state, "aborted");
  assert.equal((await cols(planA.rows[0].catalogProductId)).coverageStatus, "invalid", "not overwritten");
  assert.equal((await cols(planA.rows[0].catalogProductId)).policySyncedAt, null);

  const b = await setup(2);
  const planB = await buildReadinessPlan({ prisma, port: b.port, storeId: b.storeId, shop: b.shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  let firstB = true;
  const digestChanged = await applyReadinessPlan({
    prisma, port: b.port, storeId: b.storeId, shop: b.shop, approvedHash: planB.hash,
    readShopPolicyJson: async () => ENFORCEMENT_DISABLED,
    onManifest: async () => { if (firstB) { firstB = false; b.port.externalWrite(planB.rows[0].productGid, canonicalPolicyJson(buildProductPolicyValue({ profileId: planB.rows[0].profileId, profileRevision: planB.rows[0].profileRevision, policyRevision: 1 }))); } },
  });
  assert.equal(digestChanged.state, "aborted");
  assert.match(digestChanged.abortedBecause?.[0] ?? "", /metafield changed/);
  assert.equal((await cols(planB.rows[0].catalogProductId)).policySyncedAt, null);
});

test("rollback restores the before-values for rows still holding what the run wrote, and leaves changed rows alone", async () => {
  const { shop, storeId, port, items } = await setup(3);
  const plan = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: ENFORCEMENT_DISABLED });
  const done = await applyReadinessPlan({ prisma, port, storeId, shop, approvedHash: plan.hash, readShopPolicyJson: async () => ENFORCEMENT_DISABLED, onManifest: async () => {} });
  assert.equal(done.state, "completed");
  await prisma.catalogProduct.update({ where: { id: items[2].id }, data: { coverageStatus: "invalid" } });

  port.calls.length = 0;
  const rb = await rollbackReadiness({ prisma, storeId, shop, manifest: JSON.parse(JSON.stringify(done.manifest)), onManifest: async () => {} });
  assert.equal(rb.restored, 2);
  assert.equal(rb.skipped.length, 1);
  assert.equal(port.calls.length, 0, "rollback never touches Shopify");
  for (const it of items.slice(0, 2)) {
    const c = await cols(it.id);
    assert.equal(c.policySyncedAt, null);
    assert.equal(c.policyDigest, null);
    assert.equal(c.enforcementReady, false);
  }
  assert.equal((await cols(items[2].id)).coverageStatus, "invalid", "changed row left alone");
});

test("the read-only port passes reads through and refuses (and counts) every write", async () => {
  const port = new FakeWritePort();
  const counter = { attempts: 0 };
  const ro = readOnlyPort(port, counter);
  await ro.readProductPolicies(["gid://shopify/Product/1"]);
  await assert.rejects(ro.setProductPolicies([{ productGid: "gid://shopify/Product/1", valueJson: "{}", compareDigest: null }]), /read-only/);
  await assert.rejects(ro.deleteProductPolicy("gid://shopify/Product/1", null), /read-only/);
  assert.equal(counter.attempts, 2);
  assert.deepEqual(port.calls.map((c) => c.op), ["read"]);
});
