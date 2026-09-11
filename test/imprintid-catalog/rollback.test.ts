/**
 * Task 6A §8 / 6A.1 §6 §9 — rollback with compare-and-set.
 *
 * Proves: the previous override and metafield value are restored from the stored
 * snapshot; the restore presents the digest THIS job wrote, so a third-party change since
 * then is a hard conflict; "restore to absent" refuses to delete a concurrently changed
 * value; rollback is idempotent, store-scoped, leased, and blocked while enforcement is
 * enabled.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { planBulkAssignment } from "../../app/lib/catalog/dry-run.ts";
import { confirmAndCreateJob } from "../../app/lib/catalog/apply.ts";
import { processAssignmentJob } from "../../app/lib/catalog/processor.ts";
import { planRollback, processRollbackJob } from "../../app/lib/catalog/rollback.ts";
import { canonicalPolicyJson, buildProductPolicyValue } from "../../app/lib/catalog/policy-value.ts";
import {
  prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride,
  FakeWritePort, ENFORCEMENT_DISABLED, ENFORCEMENT_ENABLED,
  overrideKeyFor
} from "./helpers.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

const OTHER_POLICY = JSON.stringify({ schema: 1, required: true, active: true, profileRef: "someone-else", profileRevision: 9, policyRevision: 9 });

async function completedJob(opts: { seedPrevOverride?: boolean; seedPrevPolicy?: boolean } = {}) {
  const domain = makeShopDomain("catalog-rb");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const oldProfile = await seedProfile(storeId, { name: "Old", currency: "USD" });
  const newProfile = await seedProfile(storeId, { name: "New", currency: "USD" });
  const port = new FakeWritePort();

  const products: string[] = [];
  for (let i = 0; i < 3; i++) {
    const p = await seedCatalogProduct(storeId);
    products.push(p.shopifyProductId);
    if (opts.seedPrevOverride) await seedOverride(storeId, p.shopifyProductId, oldProfile.id, { basePriceCents: 1000 + i });
    if (opts.seedPrevPolicy) {
      port.seedExisting(p.shopifyProductId, JSON.stringify({ schema: 1, required: true, active: true, profileRef: oldProfile.id, profileRevision: 1, policyRevision: 1 }));
    }
  }

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: products }, pricingProfileId: newProfile.id, replaceExisting: true, idempotencyKey: `d-${Math.random()}`,
  });
  assert.ok(dry.ok);
  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok);

  const run = await processAssignmentJob(prisma, storeId, dry.jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(run.status, "completed", JSON.stringify(run));
  return { domain, storeId, jobId: dry.jobId, oldProfile, newProfile, products, port };
}

async function rollbackToCompletion(storeId: string, jobId: string, port: FakeWritePort, force = false) {
  let r = await processRollbackJob(prisma, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED, force });
  let guard = 0;
  while (r.more && guard++ < 200) {
    r = await processRollbackJob(prisma, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED, force });
  }
  return r;
}

test("restores a previously absent metafield by deleting it, and removes the job-created override", async () => {
  const { storeId, jobId, products, port } = await completedJob();
  for (const gid of products) assert.notEqual(port.current(gid), "");

  const plan = await planRollback(prisma, storeId, jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(plan.ok);
  assert.equal(plan.itemCount, 3);

  const result = await rollbackToCompletion(storeId, plan.jobId, port);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.restored, 3);

  for (const gid of products) {
    assert.equal(await prisma.productPricingOverride.count({ where: { storeId, shopifyProductId: overrideKeyFor(gid) } }), 0);
    assert.equal(port.current(gid), "", "metafield deleted");
    const cat = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: gid } });
    assert.equal(cat.policySyncedAt, null);
    assert.equal(cat.policyDigest, null);
    assert.equal(cat.coverageStatus, "unassigned");
  }
});

test("restores a pre-existing override AND a pre-existing metafield value", async () => {
  const { storeId, jobId, products, oldProfile, port } = await completedJob({ seedPrevOverride: true, seedPrevPolicy: true });
  const plan = await planRollback(prisma, storeId, jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(plan.ok);
  const result = await rollbackToCompletion(storeId, plan.jobId, port);
  assert.equal(result.status, "rolled_back", JSON.stringify(result));

  for (const gid of products) {
    const ov = await prisma.productPricingOverride.findFirstOrThrow({ where: { storeId, shopifyProductId: overrideKeyFor(gid) } });
    assert.equal(ov.pricingProfileId, oldProfile.id, "override restored to the previous profile");
    const restored = JSON.parse(port.current(gid));
    assert.equal(restored.profileRef, oldProfile.id, "metafield restored to the previous value");
  }
});

test("§6 — a value changed after the assignment is a hard conflict and is NOT overwritten", async () => {
  const { storeId, jobId, products, port } = await completedJob({ seedPrevOverride: true, seedPrevPolicy: true });

  // A third party rewrites one product's policy after our job wrote it.
  port.externalWrite(products[1]!, OTHER_POLICY);
  const foreignValue = port.current(products[1]!);

  const plan = await planRollback(prisma, storeId, jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(plan.ok);
  const result = await rollbackToCompletion(storeId, plan.jobId, port);

  assert.equal(result.status, "partial");
  assert.equal(result.conflicts, 1);
  assert.equal(result.restored, 2);
  assert.equal(port.current(products[1]!), foreignValue, "the third party's value survived untouched");

  const conflicted = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId: plan.jobId, shopifyProductId: products[1]! } });
  assert.equal(conflicted.errorCode, "PERMANENT_ROLLBACK_CONFLICT");
});

test("§6 — restore-to-absent refuses to delete a concurrently changed value", async () => {
  const { storeId, jobId, products, port } = await completedJob(); // previously absent
  port.externalWrite(products[0]!, OTHER_POLICY);
  const foreignValue = port.current(products[0]!);

  const plan = await planRollback(prisma, storeId, jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(plan.ok);
  const result = await rollbackToCompletion(storeId, plan.jobId, port);

  assert.equal(result.conflicts, 1);
  assert.equal(port.current(products[0]!), foreignValue, "the concurrently changed metafield was NOT deleted");
  assert.equal(result.restored, 2, "the untouched products still rolled back");
});

test("a forced rollback overrides a conflict", async () => {
  const { storeId, jobId, products, port } = await completedJob({ seedPrevOverride: true, seedPrevPolicy: true });
  port.externalWrite(products[0]!, OTHER_POLICY);

  const plan = await planRollback(prisma, storeId, jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(plan.ok);
  const result = await rollbackToCompletion(storeId, plan.jobId, port, true);
  assert.equal(result.status, "rolled_back", JSON.stringify(result));
  assert.equal(result.restored, 3);
});

test("rollback planning refuses while shop enforcement is enabled", async () => {
  const { storeId, jobId } = await completedJob();
  const plan = await planRollback(prisma, storeId, jobId, { shopEnforcementPolicyJson: ENFORCEMENT_ENABLED });
  assert.equal(plan.ok, false);
  assert.match(plan.code, /ENFORCEMENT/);
});

test("rollback processing refuses while shop enforcement is enabled", async () => {
  const { storeId, jobId, port } = await completedJob();
  const plan = await planRollback(prisma, storeId, jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(plan.ok);
  const r = await processRollbackJob(prisma, storeId, plan.jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_ENABLED });
  assert.equal(r.refused?.reason, "enabled");
  assert.equal(r.restored, 0);
});

test("rollback is idempotent — a second pass performs no further writes", async () => {
  const { storeId, jobId, port } = await completedJob({ seedPrevOverride: true, seedPrevPolicy: true });
  const plan = await planRollback(prisma, storeId, jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(plan.ok);
  await rollbackToCompletion(storeId, plan.jobId, port);
  const setCalls = port.calls.filter((c) => c.op === "set").length;
  const second = await processRollbackJob(prisma, storeId, plan.jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(second.status, "rolled_back");
  assert.equal(port.calls.filter((c) => c.op === "set").length, setCalls, "no further writes");
});

test("Task 6A.3B §2 — a zero-write rollback item counts as `unchanged`, never `restored`/`succeeded`", async () => {
  const domain = makeShopDomain("catalog-rb");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const profile = await seedProfile(storeId, { name: "Target", currency: "USD" });

  // A verification no-op assignment: override already on target, Shopify policy already
  // correct, so the assignment wrote NOTHING and the item is `unchanged`.
  const prod = await seedCatalogProduct(storeId, { title: "LNY01", coverageStatus: "unassigned", policySyncedAt: null });
  await seedOverride(storeId, prod.shopifyProductId, profile.id);
  const overrideBefore = await prisma.productPricingOverride.findFirstOrThrow({
    where: { storeId, shopifyProductId: overrideKeyFor(prod.shopifyProductId) },
  });

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: [prod.shopifyProductId] }, pricingProfileId: profile.id, replaceExisting: false, idempotencyKey: `rbnoop-${Math.random()}`,
  });
  assert.ok(dry.ok);
  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok);

  const port = new FakeWritePort();
  port.seedExisting(prod.shopifyProductId, canonicalPolicyJson(buildProductPolicyValue({ profileId: profile.id, profileRevision: 1, policyRevision: 1 })));
  const assignRun = await processAssignmentJob(prisma, storeId, dry.jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(assignRun.status, "completed");
  assert.equal(assignRun.unchanged, 1);

  const setsAfterAssign = port.calls.filter((c) => c.op === "set").length;
  const deletesAfterAssign = port.calls.filter((c) => c.op === "delete").length;

  const plan = await planRollback(prisma, storeId, dry.jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.equal(plan.itemCount, 1);

  const result = await rollbackToCompletion(storeId, plan.jobId, port);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.restored, 0, "nothing was written back");
  assert.equal(result.unchanged, 1, "the item was already at the previous state");

  assert.equal(port.calls.filter((c) => c.op === "set").length, setsAfterAssign, "rollback performed no metafieldsSet");
  assert.equal(port.calls.filter((c) => c.op === "delete").length, deletesAfterAssign, "rollback performed no metafieldsDelete");

  const rbJob = await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: plan.jobId } });
  assert.equal(rbJob.succeeded, 0, "job.succeeded is not inflated by a no-op");
  assert.equal(rbJob.unchanged, 1, "job.unchanged records the no-op distinctly");

  const rbItem = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId: plan.jobId } });
  assert.equal(rbItem.status, "unchanged");

  const audit = await prisma.bulkAssignmentAudit.findFirstOrThrow({ where: { jobId: plan.jobId, event: "rollback_finished" } });
  const detail = JSON.parse(audit.detail);
  assert.equal(detail.restored, 0);
  assert.equal(detail.unchanged, 1, "the audit distinguishes restored from unchanged");

  const overrideAfter = await prisma.productPricingOverride.findFirstOrThrow({
    where: { storeId, shopifyProductId: overrideKeyFor(prod.shopifyProductId) },
  });
  assert.equal(overrideAfter.updatedAt.getTime(), overrideBefore.updatedAt.getTime(), "override untouched through assign + rollback");
});

test("planRollback is store-scoped: shop B cannot roll back shop A's job", async () => {
  const a = await completedJob();
  const bDomain = makeShopDomain("catalog-rb");
  shops.push(bDomain);
  const bStoreId = await seedStore(bDomain, "USD");
  const plan = await planRollback(prisma, bStoreId, a.jobId, { shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "JOB_NOT_FOUND");
});
