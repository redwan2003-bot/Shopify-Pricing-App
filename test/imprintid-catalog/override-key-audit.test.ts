/**
 * Task 6A.3B §4 — legacy override-key safety audit.
 *
 * Proves the four states (bare-only / gid-only / identical collision / conflicting
 * collision) are classified correctly, that `auditOverrideKeys` reads both key forms
 * without writing, and that the assignment processor FAILS CLOSED on a conflicting pair
 * (never writes a product whose effective price is ambiguous) while leaving every record
 * exactly as it found it.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { planBulkAssignment } from "../../app/lib/catalog/dry-run.ts";
import { confirmAndCreateJob } from "../../app/lib/catalog/apply.ts";
import { processAssignmentJob } from "../../app/lib/catalog/processor.ts";
import {
  auditOverrideKeys,
  classifyOverrideKeyState,
} from "../../app/lib/catalog/override-key-audit.ts";
import {
  prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride,
  FakeWritePort, ENFORCEMENT_DISABLED, overrideKeyFor,
} from "./helpers.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

const sem = (pricingProfileId: string | null, isActive = true, basePriceCents: number | null = null) => ({
  pricingProfileId,
  isActive,
  basePriceCents,
});

test("classifyOverrideKeyState — the four states", () => {
  assert.equal(classifyOverrideKeyState(undefined, undefined), "none");
  assert.equal(classifyOverrideKeyState(sem("p1"), undefined), "bare-only");
  assert.equal(classifyOverrideKeyState(undefined, sem("p1")), "gid-only");
  assert.equal(classifyOverrideKeyState(sem("p1", true, 500), sem("p1", true, 500)), "collision-identical");
  assert.equal(classifyOverrideKeyState(sem("p1"), sem("p2")), "collision-conflict");
  assert.equal(classifyOverrideKeyState(sem("p1", true), sem("p1", false)), "collision-conflict");
  assert.equal(classifyOverrideKeyState(sem("p1", true, 100), sem("p1", true, 200)), "collision-conflict");
});

async function scenario() {
  const domain = makeShopDomain("catalog-keyaudit");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const profile = await seedProfile(storeId, { name: "Target", currency: "USD" });
  const other = await seedProfile(storeId, { name: "Other", currency: "USD" });
  return { domain, storeId, profile, other };
}

/** Writes a raw GID-keyed override row — the legacy shape the audit must detect. */
async function seedGidKeyedOverride(storeId: string, gid: string, pricingProfileId: string | null, opts: { isActive?: boolean; basePriceCents?: number | null } = {}) {
  await prisma.productPricingOverride.create({
    data: { storeId, shopifyProductId: gid, pricingProfileId, isActive: opts.isActive ?? true, basePriceCents: opts.basePriceCents ?? null },
  });
}

test("auditOverrideKeys — bare-only is healthy, gid-only is a legacy flag, neither is a conflict", async () => {
  const { storeId, profile } = await scenario();
  const bareOnly = await seedCatalogProduct(storeId);
  const gidOnly = await seedCatalogProduct(storeId);
  await seedOverride(storeId, bareOnly.shopifyProductId, profile.id);
  await seedGidKeyedOverride(storeId, gidOnly.shopifyProductId, profile.id);

  const audit = await auditOverrideKeys(prisma, storeId, [bareOnly.shopifyProductId, gidOnly.shopifyProductId]);
  assert.equal(audit.ok, true, "no conflicts");
  assert.equal(audit.conflicts.length, 0);
  assert.equal(audit.blockedGids.size, 0);
  const legacy = audit.findings.find((f) => f.productGid === gidOnly.shopifyProductId);
  assert.equal(legacy?.state, "gid-only");
  assert.equal(audit.findings.find((f) => f.productGid === bareOnly.shopifyProductId), undefined, "a healthy bare-only row is not even a finding");
});

test("auditOverrideKeys — an identical collision is flagged but not fail-closed", async () => {
  const { storeId, profile } = await scenario();
  const p = await seedCatalogProduct(storeId);
  await seedOverride(storeId, p.shopifyProductId, profile.id, { basePriceCents: 700 });
  await seedGidKeyedOverride(storeId, p.shopifyProductId, profile.id, { basePriceCents: 700 });

  const audit = await auditOverrideKeys(prisma, storeId, [p.shopifyProductId]);
  assert.equal(audit.ok, true);
  assert.equal(audit.findings[0]!.state, "collision-identical");
  assert.equal(audit.findings[0]!.failClosed, false);
});

test("auditOverrideKeys — a conflicting collision fails closed", async () => {
  const { storeId, profile, other } = await scenario();
  const p = await seedCatalogProduct(storeId);
  await seedOverride(storeId, p.shopifyProductId, profile.id);
  await seedGidKeyedOverride(storeId, p.shopifyProductId, other.id);

  const audit = await auditOverrideKeys(prisma, storeId, [p.shopifyProductId]);
  assert.equal(audit.ok, false);
  assert.equal(audit.conflicts.length, 1);
  assert.equal(audit.conflicts[0]!.state, "collision-conflict");
  assert.ok(audit.blockedGids.has(p.shopifyProductId));
});

test("the audit performs NO writes", async () => {
  const { storeId, profile, other } = await scenario();
  const p = await seedCatalogProduct(storeId);
  await seedOverride(storeId, p.shopifyProductId, profile.id);
  await seedGidKeyedOverride(storeId, p.shopifyProductId, other.id);
  const before = await prisma.productPricingOverride.findMany({ where: { storeId }, orderBy: { shopifyProductId: "asc" } });

  await auditOverrideKeys(prisma, storeId, [p.shopifyProductId]);

  const after = await prisma.productPricingOverride.findMany({ where: { storeId }, orderBy: { shopifyProductId: "asc" } });
  assert.deepEqual(
    after.map((r) => ({ k: r.shopifyProductId, p: r.pricingProfileId, a: r.isActive, u: r.updatedAt.getTime() })),
    before.map((r) => ({ k: r.shopifyProductId, p: r.pricingProfileId, a: r.isActive, u: r.updatedAt.getTime() })),
  );
});

test("the dry run surfaces a conflicting collision as a blocking error", async () => {
  const { domain, storeId, profile, other } = await scenario();
  const p = await seedCatalogProduct(storeId);
  await seedOverride(storeId, p.shopifyProductId, profile.id);
  await seedGidKeyedOverride(storeId, p.shopifyProductId, other.id);

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: [p.shopifyProductId] }, pricingProfileId: profile.id, replaceExisting: false, idempotencyKey: "keyconf",
  });
  assert.ok(dry.ok);
  assert.ok(dry.blockingErrors.some((e) => /legacy pricing-override/i.test(e)), JSON.stringify(dry.blockingErrors));
});

test("the processor FAILS CLOSED on a conflicting pair, writes nothing, and touches no override record", async () => {
  const { domain, storeId, profile, other } = await scenario();
  const clean = await seedCatalogProduct(storeId, { title: "clean" });
  const conflicted = await seedCatalogProduct(storeId, { title: "conflicted" });

  // Both products are genuinely unassigned at dry-run + apply time.
  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: [clean.shopifyProductId, conflicted.shopifyProductId] },
    pricingProfileId: profile.id, replaceExisting: false, idempotencyKey: "prockeyconf",
  });
  assert.ok(dry.ok);
  assert.equal(dry.blockingErrors.length, 0);
  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok);
  assert.equal(applied.totalItems, 2);

  // A conflicting legacy/bare pair appears for `conflicted` AFTER the job was materialized.
  await seedGidKeyedOverride(storeId, conflicted.shopifyProductId, other.id);
  await seedOverride(storeId, conflicted.shopifyProductId, profile.id, { basePriceCents: 999 });
  const overridesBefore = await prisma.productPricingOverride.findMany({ where: { storeId }, orderBy: { shopifyProductId: "asc" } });

  const port = new FakeWritePort();
  const result = await processAssignmentJob(prisma, storeId, dry.jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(result.status, "partial");
  assert.equal(result.failed, 1);

  const conflictedItem = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId: dry.jobId, shopifyProductId: conflicted.shopifyProductId } });
  assert.equal(conflictedItem.status, "failed");
  assert.equal(conflictedItem.errorCode, "PERMANENT_OVERRIDE_KEY_CONFLICT");

  const cleanItem = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId: dry.jobId, shopifyProductId: clean.shopifyProductId } });
  assert.equal(cleanItem.status, "succeeded", "the healthy product in the same batch is unaffected");

  // Every override record for `conflicted` is exactly as it was — no migrate, no delete.
  const overridesAfter = await prisma.productPricingOverride.findMany({ where: { storeId }, orderBy: { shopifyProductId: "asc" } });
  const forConflicted = (rows: typeof overridesAfter) => rows.filter((r) => r.shopifyProductId === conflicted.shopifyProductId || r.shopifyProductId === overrideKeyFor(conflicted.shopifyProductId));
  assert.deepEqual(
    forConflicted(overridesAfter).map((r) => ({ k: r.shopifyProductId, p: r.pricingProfileId, b: r.basePriceCents, u: r.updatedAt.getTime() })),
    forConflicted(overridesBefore).map((r) => ({ k: r.shopifyProductId, p: r.pricingProfileId, b: r.basePriceCents, u: r.updatedAt.getTime() })),
  );
});
