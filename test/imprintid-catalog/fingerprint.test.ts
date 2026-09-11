/**
 * Task 6A.1 §4 — the STRONG target-state fingerprint.
 *
 * Proves the fingerprint detects a change that leaves the row count, the newest
 * timestamp and the sum of profile revisions all unchanged — the exact blind spot of the
 * original aggregate-only fingerprint — and that the whole thing streams in bounded
 * passes so the browser only ever gets the digest.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { computeTargetStateFingerprint, FINGERPRINT_BATCH } from "../../app/lib/catalog/fingerprint.ts";
import { planBulkAssignment } from "../../app/lib/catalog/dry-run.ts";
import { confirmAndCreateJob } from "../../app/lib/catalog/apply.ts";
import {
  prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride,
  seedManyCatalogProducts, ENFORCEMENT_DISABLED,
  overrideKeyFor
} from "./helpers.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

async function scenario() {
  const domain = makeShopDomain("catalog-fp");
  shops.push(domain);
  return { domain, storeId: await seedStore(domain, "USD") };
}

const target = (profileId: string, digest: string | null = "d") => ({
  profileId,
  profileRevision: 1,
  profileDigest: digest,
  replaceExisting: false,
});

test("swapping which product carries an override changes the digest (count unchanged)", async () => {
  const { storeId } = await scenario();
  const p = await seedProfile(storeId);
  const other = await seedProfile(storeId, { name: "Other" });
  const a = await seedCatalogProduct(storeId);
  const b = await seedCatalogProduct(storeId);
  await seedOverride(storeId, a.shopifyProductId, other.id);

  const before = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id));

  // Move the override from A to B — same number of products, same number of overrides.
  await prisma.productPricingOverride.deleteMany({ where: { storeId, shopifyProductId: overrideKeyFor(a.shopifyProductId) } });
  await seedOverride(storeId, b.shopifyProductId, other.id);

  const after = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id));
  assert.notEqual(after.digest, before.digest, "the per-product target state moved, so the digest must change");
  assert.equal(after.productCount, before.productCount);
});

test("replacing one product with another (delete + add in the same tick) changes the digest", async () => {
  const { storeId } = await scenario();
  const p = await seedProfile(storeId);
  const keep = await seedCatalogProduct(storeId, { title: "keep" });
  const gone = await seedCatalogProduct(storeId, { title: "gone", shopifyUpdatedAt: new Date("2026-01-01") });

  const before = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id));

  await prisma.catalogProduct.delete({ where: { id: gone.id } });
  await seedCatalogProduct(storeId, { title: "new", shopifyUpdatedAt: new Date("2026-01-01") }); // same newest timestamp

  const after = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id));
  assert.equal(after.productCount, before.productCount, "count is identical");
  assert.notEqual(after.digest, before.digest, "but the set of product GIDs changed");
  void keep;
});

test("a change to the target profile's content digest alone changes the fingerprint", async () => {
  const { storeId } = await scenario();
  const p = await seedProfile(storeId);
  await seedCatalogProduct(storeId);

  const before = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id, "digest-v1"));
  const after = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id, "digest-v2"));
  assert.notEqual(after.digest, before.digest);
});

test("an identical catalog + identical target yields an identical digest (deterministic)", async () => {
  const { storeId } = await scenario();
  const p = await seedProfile(storeId);
  for (let i = 0; i < 5; i++) await seedCatalogProduct(storeId);

  const a = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id));
  const b = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id));
  assert.equal(a.digest, b.digest);
});

test("the fingerprint streams in bounded passes for a large selection", async () => {
  const { storeId } = await scenario();
  const p = await seedProfile(storeId);
  await seedManyCatalogProducts(storeId, FINGERPRINT_BATCH * 2 + 10);

  const r = await computeTargetStateFingerprint(prisma, storeId, { kind: "all" }, target(p.id));
  assert.equal(r.productCount, FINGERPRINT_BATCH * 2 + 10);
  assert.equal(r.batches, 3, "consumed in FINGERPRINT_BATCH-sized passes, never all at once");
});

test("§4 end-to-end — apply rejects an equal-count override swap made after the dry run", async () => {
  const { domain, storeId } = await scenario();
  const p = await seedProfile(storeId, { name: "Target" });
  const other = await seedProfile(storeId, { name: "Other" });
  const a = await seedCatalogProduct(storeId);
  const b = await seedCatalogProduct(storeId);
  await seedOverride(storeId, a.shopifyProductId, other.id);

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: p.id, replaceExisting: true, idempotencyKey: "swap",
  });
  assert.ok(dry.ok);

  // Swap the override A→B. Same product count, same override count, same profile
  // revisions — only WHICH product is pre-assigned changed.
  await prisma.productPricingOverride.deleteMany({ where: { storeId, shopifyProductId: overrideKeyFor(a.shopifyProductId) } });
  await seedOverride(storeId, b.shopifyProductId, other.id);

  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.equal(applied.ok, false);
  assert.ok(["TARGET_CHANGED", "CATALOG_CHANGED"].includes(applied.code), applied.code);
});
