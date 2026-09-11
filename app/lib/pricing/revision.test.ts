/**
 * Task 6A.1 §5 — `PricingProfile.revision` integrity.
 *
 * Proves that a change to ANY pricing-affecting table bumps the revision (via the
 * centralized `syncPricingProfileRevision` hook), that a no-op save does not, and that
 * the content digest detects a change that a naive count / newest-timestamp / revision-sum
 * signal would miss.
 *
 * Runs against the project dev.sqlite with a disposable shop, cleaned up in `after`.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  computePricingContentDigest,
  digestPricingContent,
  pricingContentProjection,
  syncPricingProfileRevision,
  profileRevisionIdentity,
  revisionIdentityUnchanged,
  ensurePricingContentDigest,
} from "./revision.ts";
import { importPricingProfile } from "../pricing-import/import.ts";
import { buildLny01PricingInput } from "../../../prisma/seed-data/lny01.ts";

const prisma = new PrismaClient({ datasources: { db: { url: "file:dev.sqlite?socket_timeout=45&connection_limit=1" } } });
const SHOP = `revision-integrity-${process.pid}.myshopify.com`;

after(async () => {
  const store = await prisma.store.findUnique({ where: { shopDomain: SHOP }, select: { id: true } });
  if (store) {
    const profiles = await prisma.pricingProfile.findMany({ where: { storeId: store.id }, select: { id: true } });
    for (const p of profiles) {
      await prisma.quantityTier.deleteMany({ where: { pricingProfileId: p.id } });
      await prisma.decorationRule.deleteMany({ where: { pricingProfileId: p.id } });
      await prisma.decorationColorCharge.deleteMany({ where: { pricingProfileId: p.id } });
      await prisma.optionGroup.deleteMany({ where: { pricingProfileId: p.id } });
      await prisma.productColor.deleteMany({ where: { pricingProfileId: p.id } });
      await prisma.productionRule.deleteMany({ where: { pricingProfileId: p.id } });
      await prisma.packagingRule.deleteMany({ where: { pricingProfileId: p.id } });
    }
    // Task 6A.3B §5 tests also create catalog + assignment-job rows for the "in-flight
    // dry run" scenario.
    await prisma.bulkAssignmentAudit.deleteMany({ where: { storeId: store.id } });
    await prisma.bulkAssignmentItem.deleteMany({ where: { storeId: store.id } });
    await prisma.bulkAssignmentJob.deleteMany({ where: { storeId: store.id } });
    await prisma.productPricingOverride.deleteMany({ where: { storeId: store.id } });
    await prisma.catalogProduct.deleteMany({ where: { storeId: store.id } });
    await prisma.pricingProfile.deleteMany({ where: { storeId: store.id } });
    await prisma.store.deleteMany({ where: { id: store.id } });
  }
  await prisma.$disconnect();
});

async function freshProfile() {
  const result = await importPricingProfile(prisma, buildLny01PricingInput(SHOP));
  return result.pricingProfileId;
}

async function revisionOf(id: string) {
  const p = await prisma.pricingProfile.findUniqueOrThrow({ where: { id }, select: { revision: true, contentDigest: true } });
  return p;
}

test("the import sets a content digest without inflating the revision on re-import", async () => {
  const id = await freshProfile();
  const first = await revisionOf(id);
  assert.ok(first.contentDigest, "digest is populated by the centralized hook");
  assert.equal(first.revision, 1);

  // Re-import identical data: import.ts deletes+recreates every child row (fresh cuids)
  // yet the priced output is unchanged, so the digest — and the revision — must not move.
  const reimport = await importPricingProfile(prisma, buildLny01PricingInput(SHOP));
  assert.equal(reimport.revisionChanged, false);
  const after = await revisionOf(id);
  assert.equal(after.revision, 1, "a no-op re-import does not bump the revision");
  assert.equal(after.contentDigest, first.contentDigest);
});

test("a change to EACH pricing-affecting child table bumps the revision", async () => {
  const id = await freshProfile();
  let expected = (await revisionOf(id)).revision;

  const mutate: Array<[string, () => Promise<unknown>]> = [
    ["profile currency", () => prisma.pricingProfile.update({ where: { id }, data: { currency: "CAD" } })],
    ["profile basePriceCents", () => prisma.pricingProfile.update({ where: { id }, data: { basePriceCents: 999 } })],
    ["profile isActive", () => prisma.pricingProfile.update({ where: { id }, data: { isActive: false } })],
    ["quantity tier price", async () => {
      const t = await prisma.quantityTier.findFirstOrThrow({ where: { pricingProfileId: id } });
      return prisma.quantityTier.update({ where: { id: t.id }, data: { netPriceCents: t.netPriceCents + 1 } });
    }],
    ["decoration rule price", async () => {
      const r = await prisma.decorationRule.findFirstOrThrow({ where: { pricingProfileId: id } });
      return prisma.decorationRule.update({ where: { id: r.id }, data: { listPriceCents: r.listPriceCents + 5 } });
    }],
    ["decoration color charge", async () => {
      const c = await prisma.decorationColorCharge.findFirstOrThrow({ where: { pricingProfileId: id } });
      return prisma.decorationColorCharge.update({ where: { id: c.id }, data: { netPriceCents: c.netPriceCents + 3 } });
    }],
    ["option value adjustment", async () => {
      const v = await prisma.optionValue.findFirstOrThrow({ where: { optionGroup: { pricingProfileId: id } } });
      return prisma.optionValue.update({ where: { id: v.id }, data: { priceAdjustmentCents: (v.priceAdjustmentCents ?? 0) + 7 } });
    }],
    ["option group surcharge", async () => {
      const g = await prisma.optionGroup.findFirstOrThrow({ where: { pricingProfileId: id } });
      return prisma.optionGroup.update({ where: { id: g.id }, data: { categoryPriceAdjustmentCents: (g.categoryPriceAdjustmentCents ?? 0) + 11 } });
    }],
    ["production rule fee", async () => {
      const r = await prisma.productionRule.findFirstOrThrow({ where: { pricingProfileId: id } });
      return prisma.productionRule.update({ where: { id: r.id }, data: { feeCents: (r.feeCents ?? 0) + 13 } });
    }],
    ["packaging rule fee", async () => {
      const r = await prisma.packagingRule.findFirstOrThrow({ where: { pricingProfileId: id } });
      return prisma.packagingRule.update({ where: { id: r.id }, data: { feeCents: (r.feeCents ?? 0) + 17 } });
    }],
    // A code not already in the LNY01 seed (which now carries BLACK/RED/BLUE).
    ["new product color", () => prisma.productColor.create({ data: { pricingProfileId: id, code: "FOREST_GREEN", name: "Forest Green", priceAdjustmentCents: 25 } })],
  ];

  // The centralized hook (`syncPricingProfileRevision`) is what `importPricingProfile`
  // calls inside its own transaction; here we call it directly after each mutation to
  // prove it detects the change. (The atomic-with-the-write property is covered by the
  // import path's own tests.)
  for (const [label, change] of mutate) {
    await (change as () => Promise<unknown>)();
    const result = await syncPricingProfileRevision(prisma, id);
    expected += 1;
    assert.equal(result?.changed, true, `"${label}" should be detected as a pricing change`);
    assert.equal((await revisionOf(id)).revision, expected, `"${label}" should have bumped the revision to ${expected}`);
  }

  // ...and a genuine no-op edit does NOT.
  await prisma.pricingProfile.update({ where: { id }, data: { description: "cosmetic — not priced" } });
  const noop = await syncPricingProfileRevision(prisma, id);
  assert.equal(noop?.changed, false);
  assert.equal((await revisionOf(id)).revision, expected, "a non-pricing edit does not bump the revision");
});

test("the digest catches a swap that leaves count, newest timestamp and revision-sum unchanged", async () => {
  const id = await freshProfile();
  const digestBefore = await computePricingContentDigest(prisma, id);

  // Swap two option values' price adjustments — same number of rows, and (because we do
  // NOT call the revision hook) the same stored revision and updatedAt aggregates a naive
  // signal would look at.
  const [a, b] = await prisma.optionValue.findMany({
    where: { optionGroup: { pricingProfileId: id }, priceAdjustmentCents: { not: null } },
    take: 2,
    orderBy: { id: "asc" },
  });
  assert.ok(a && b && a.priceAdjustmentCents !== b.priceAdjustmentCents, "need two option values with different adjustments");
  await prisma.optionValue.update({ where: { id: a.id }, data: { priceAdjustmentCents: b.priceAdjustmentCents } });
  await prisma.optionValue.update({ where: { id: b.id }, data: { priceAdjustmentCents: a.priceAdjustmentCents } });

  const digestAfter = await computePricingContentDigest(prisma, id);
  assert.notEqual(digestAfter, digestBefore, "the content digest changed even though the priced values only moved between rows");

  // And the identity string the dry run captures reflects it once the hook runs.
  const stale = profileRevisionIdentity(1, digestBefore);
  await syncPricingProfileRevision(prisma, id);
  const fresh = await revisionOf(id);
  assert.notEqual(profileRevisionIdentity(fresh.revision, fresh.contentDigest), stale);
});

test("the projection is order-independent and id-independent", async () => {
  const id = await freshProfile();
  const profile = await prisma.pricingProfile.findUniqueOrThrow({
    where: { id },
    include: {
      quantityTiers: true, decorationRules: true, decorationColorCharges: true,
      optionGroups: { include: { optionValues: true } }, productColors: true, productionRules: true, packagingRules: true,
    },
  });

  const a = digestPricingContent(pricingContentProjection(profile));
  // Shuffle the child arrays — the digest must not care.
  const shuffled = {
    ...profile,
    quantityTiers: [...profile.quantityTiers].reverse(),
    decorationRules: [...profile.decorationRules].reverse(),
    optionGroups: [...profile.optionGroups].reverse().map((g) => ({ ...g, optionValues: [...g.optionValues].reverse() })),
  };
  const b = digestPricingContent(pricingContentProjection(shuffled));
  assert.equal(a, b, "row order does not affect the digest");
});

// -------------------------------------------------------------------------------------
// Task 6A.3B §5 — content-digest backfill is idempotent, race-safe, and does not
// invalidate an in-flight dry run.
// -------------------------------------------------------------------------------------

test("revisionIdentityUnchanged: a null→value backfill at the same revision is NOT drift", () => {
  assert.equal(revisionIdentityUnchanged(1, null, 1, "abc"), true, "first-observation backfill landing");
  assert.equal(revisionIdentityUnchanged(1, "abc", 1, "abc"), true, "identical");
  assert.equal(revisionIdentityUnchanged(5, null, 5, null), true, "both null at same revision");
  assert.equal(revisionIdentityUnchanged(1, "abc", 2, "abc"), false, "revision moved");
  assert.equal(revisionIdentityUnchanged(1, "abc", 1, "def"), false, "digest changed value");
  assert.equal(revisionIdentityUnchanged(1, null, 2, "abc"), false, "revision moved even though digest was null");
  assert.equal(revisionIdentityUnchanged(1, "abc", 1, null), false, "digest disappeared");
});

test("ensurePricingContentDigest is idempotent and never bumps the revision", async () => {
  const id = await freshProfile();
  // Force the pre-mechanism state.
  await prisma.pricingProfile.update({ where: { id }, data: { contentDigest: null } });
  const before = await revisionOf(id);

  const d1 = await ensurePricingContentDigest(prisma, id);
  const d2 = await ensurePricingContentDigest(prisma, id);
  const d3 = await ensurePricingContentDigest(prisma, id);
  assert.ok(d1);
  assert.equal(d1, d2);
  assert.equal(d2, d3);

  const after = await revisionOf(id);
  assert.equal(after.revision, before.revision, "revision is untouched by the backfill");
  assert.equal(after.contentDigest, d1, "the digest is stored");
});

test("a concurrent backfill (conditional write) cannot clobber a value another writer stored", async () => {
  const id = await freshProfile();
  await prisma.pricingProfile.update({ where: { id }, data: { contentDigest: null } });
  const before = await revisionOf(id);

  // Two callers both observe null and compute the (identical) digest, then race to write.
  const [a, b] = await Promise.all([
    ensurePricingContentDigest(prisma, id),
    ensurePricingContentDigest(prisma, id),
  ]);
  assert.equal(a, b);
  const stored = await revisionOf(id);
  assert.equal(stored.contentDigest, a);
  assert.equal(stored.revision, before.revision, "no revision bump from either racer");
});

test("populating a previously-null digest does NOT invalidate an outstanding dry run", async () => {
  const { planBulkAssignment } = await import("../catalog/dry-run.ts");
  const { confirmAndCreateJob } = await import("../catalog/apply.ts");
  const { computeDryRunFingerprint, computeTargetStateFingerprint } = await import("../catalog/fingerprint.ts");
  const { hashSelection } = await import("../catalog/selection.ts");
  const id = await freshProfile();
  const profile = await prisma.pricingProfile.findUniqueOrThrow({ where: { id }, select: { storeId: true, revision: true } });
  const store = await prisma.store.findUniqueOrThrow({ where: { id: profile.storeId }, select: { shopDomain: true } });
  const n = Date.now();
  await prisma.catalogProduct.create({
    data: { storeId: profile.storeId, shopifyProductId: `gid://shopify/Product/${n}`, title: "P", handle: `p-${n}`, status: "ACTIVE", tags: "", shopifyUpdatedAt: new Date("2026-01-01") },
  });

  const dry = await planBulkAssignment(prisma, {
    storeId: profile.storeId, shopDomain: store.shopDomain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: id, replaceExisting: false, idempotencyKey: `digest-inflight-${n}`,
  });
  assert.ok(dry.ok, JSON.stringify(dry));

  // Reconstruct the state of a dry run captured BEFORE the digest mechanism existed:
  // `profileDigest` null on the job, and a `dryRunFingerprint` computed with no digest.
  const selection = { kind: "all" as const };
  const ts = await computeTargetStateFingerprint(prisma, profile.storeId, selection, {
    profileId: id, profileRevision: profile.revision, profileDigest: null, replaceExisting: false,
  });
  const legacyFingerprint = computeDryRunFingerprint({
    shopDomain: store.shopDomain, selectionHash: hashSelection(selection),
    profileId: id, profileRevision: profile.revision, profileDigest: null, replaceExisting: false,
    matchedCount: ts.productCount, targetStateDigest: ts.digest,
  });
  await prisma.bulkAssignmentJob.update({
    where: { id: dry.jobId },
    data: { profileDigest: null, dryRunFingerprint: legacyFingerprint },
  });

  // Now the backfill runs (e.g. someone opened the profile page) and populates the digest.
  await prisma.pricingProfile.update({ where: { id }, data: { contentDigest: null } });
  const backfilled = await ensurePricingContentDigest(prisma, id);
  assert.ok(backfilled, "digest is now populated");

  const applied = await confirmAndCreateJob(prisma, {
    storeId: profile.storeId, shopDomain: store.shopDomain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: legacyFingerprint,
    shopEnforcementPolicyJson: { schema: 1, mode: "disabled", enabled: false, adjustmentVariantGid: "gid://shopify/ProductVariant/1", installBinding: "t", policyRevision: 1 },
  });
  assert.ok(applied.ok, `a pure digest backfill must not invalidate the dry run: ${JSON.stringify(applied)}`);
});
