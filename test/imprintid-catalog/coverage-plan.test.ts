import { test, after } from "node:test";
import assert from "node:assert/strict";
import { applyCoveragePlan, buildCoveragePlan, checkCoverageContract, rollbackCoveragePlan, type CoverageManifest } from "../../app/lib/catalog/coverage-plan.ts";
import { prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride } from "./helpers.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

async function setup(linked = 3) {
  const shop = makeShopDomain("covplan");
  shops.push(shop);
  const storeId = await seedStore(shop, "USD");
  const profile = await seedProfile(storeId);
  const rows = [];
  for (let i = 0; i < linked; i++) {
    const p = await seedCatalogProduct(storeId, { gid: `gid://shopify/Product/${9100 + i}` });
    await seedOverride(storeId, p.shopifyProductId, profile.id);
    rows.push(p);
  }
  await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/9199" }); // no override
  return { shop, storeId, profile, rows };
}

const cols = (id: string) =>
  prisma.catalogProduct.findUniqueOrThrow({
    where: { id },
    select: { coverageStatus: true, assignedProfileId: true, assignmentSource: true, enforcementReady: true, policySyncedAt: true, policyDigest: true },
  });

test("plan lists exactly the changing rows, writes nothing, and passes the contract", async () => {
  const { shop, storeId, profile, rows } = await setup(3);
  const plan = await buildCoveragePlan(prisma, storeId, shop);
  assert.equal(plan.scanned, 4);
  assert.equal(plan.totals.changes, 3);
  assert.deepEqual(plan.totals.byTransition, { "unassigned->assigned": 3 });
  assert.equal(plan.totals.enforcementReadyChanges, 0);
  assert.ok(plan.changes.every((c) => c.after.assignedProfileId === profile.id && c.after.enforcementReady === false));
  assert.deepEqual(checkCoverageContract(plan, { changes: 3, transition: "unassigned->assigned" }), []);
  assert.equal((await cols(rows[0].id)).coverageStatus, "unassigned", "plan wrote nothing");
  assert.equal((await buildCoveragePlan(prisma, storeId, shop)).hash, plan.hash, "hash is deterministic");
});

test("the contract rejects a wrong count, a foreign transition, and any enforcementReady change", () => {
  const base = {
    shop: "s", storeId: "i", scanned: 1, hash: "h",
    changes: [],
    totals: { changes: 2, byTransition: { "unassigned->assigned": 1, "assigned->unassigned": 1 }, enforcementReadyChanges: 1, withoutProfile: 0 },
  };
  const problems = checkCoverageContract(base, { changes: 1, transition: "unassigned->assigned" });
  assert.equal(problems.length, 3, problems.join(" | "));
});

test("a plan for the wrong shop is refused", async () => {
  const { storeId } = await setup(1);
  await assert.rejects(buildCoveragePlan(prisma, storeId, "someone-else.myshopify.com"), /does not belong/);
});

test("apply writes exactly the plan, leaves policySyncedAt/policyDigest alone, and rollback restores", async () => {
  const { shop, storeId, profile, rows } = await setup(3);
  const syncedAt = new Date("2026-02-01T00:00:00Z");
  await prisma.catalogProduct.update({ where: { id: rows[0].id }, data: { policySyncedAt: syncedAt, policyDigest: "keep-me" } });
  // row 0 is policy-synced, so reconcile would flip enforcementReady -> the contract must catch that
  const risky = await buildCoveragePlan(prisma, storeId, shop);
  assert.equal(risky.totals.enforcementReadyChanges, 1);
  assert.ok(checkCoverageContract(risky, { changes: 3, transition: "unassigned->assigned" }).length > 0);
  await prisma.catalogProduct.update({ where: { id: rows[0].id }, data: { policySyncedAt: null, policyDigest: null } });

  const plan = await buildCoveragePlan(prisma, storeId, shop);
  let manifest: CoverageManifest | undefined;
  const snapshots: string[] = [];
  const result = await applyCoveragePlan({
    prisma, storeId, shop, approvedHash: plan.hash,
    onManifest: async (m) => { manifest = JSON.parse(JSON.stringify(m)); snapshots.push(m.state); },
  });
  assert.equal(result.state, "completed");
  assert.equal(result.updated, 3);
  assert.equal(snapshots[0], "planned", "manifest existed before the first write");
  for (const r of rows) {
    const c = await cols(r.id);
    assert.equal(c.coverageStatus, "assigned");
    assert.equal(c.assignedProfileId, profile.id);
    assert.equal(c.assignmentSource, "override");
    assert.equal(c.enforcementReady, false);
    assert.equal(c.policySyncedAt, null);
    assert.equal(c.policyDigest, null);
  }

  const rb = await rollbackCoveragePlan({ prisma, storeId, shop, manifest: manifest!, onManifest: async () => {} });
  assert.equal(rb.restored, 3);
  assert.deepEqual(rb.skipped, []);
  for (const r of rows) {
    const c = await cols(r.id);
    assert.equal(c.coverageStatus, "unassigned");
    assert.equal(c.assignedProfileId, null);
    assert.equal(c.assignmentSource, null);
  }
});

test("apply refuses a stale plan and writes nothing", async () => {
  const { shop, storeId, rows } = await setup(2);
  const plan = await buildCoveragePlan(prisma, storeId, shop);
  const extra = await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/9150" });
  const profile = await seedProfile(storeId);
  await seedOverride(storeId, extra.shopifyProductId, profile.id);
  const result = await applyCoveragePlan({ prisma, storeId, shop, approvedHash: plan.hash, onManifest: async () => { assert.fail("no manifest for a refused run"); } });
  assert.equal(result.state, "aborted");
  assert.ok(result.refusedBecause);
  assert.equal((await cols(rows[0].id)).coverageStatus, "unassigned");
});

test("a row changed after the plan is a conflict: it is not overwritten and the run stops", async () => {
  const { shop, storeId, rows } = await setup(2);
  const plan = await buildCoveragePlan(prisma, storeId, shop);
  const manifests: CoverageManifest[] = [];
  const result = await applyCoveragePlan({
    prisma, storeId, shop, approvedHash: plan.hash,
    onManifest: async (m) => {
      manifests.push(JSON.parse(JSON.stringify(m)));
      // concurrent change lands between the manifest and the first update
      if (manifests.length === 1) await prisma.catalogProduct.update({ where: { id: rows[0].id }, data: { coverageStatus: "invalid" } });
    },
  });
  assert.equal(result.state, "aborted");
  assert.ok(result.abortedBecause?.length);
  assert.equal((await cols(rows[0].id)).coverageStatus, "invalid", "the concurrent value was not overwritten");
});
