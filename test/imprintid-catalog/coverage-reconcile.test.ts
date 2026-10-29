import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { reconcileCatalogCoverage, reconcileCoverageAfterSync, reconcileCoverageForProducts } from "../../app/lib/catalog/coverage.ts";
import { prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride } from "./helpers.ts";

/**
 * Coverage reconciliation: scoping, dry run, the columns it must never write, and the
 * best-effort wrappers the sync and the SKU link rely on.
 */

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

async function newStore() {
  const domain = makeShopDomain("coverage");
  shops.push(domain);
  return { domain, storeId: await seedStore(domain, "USD") };
}

const row = (id: string) =>
  prisma.catalogProduct.findUniqueOrThrow({
    where: { id },
    select: { coverageStatus: true, assignedProfileId: true, assignmentSource: true, enforcementReady: true, policySyncedAt: true, policyDigest: true },
  });

test("an EMPTY product list scopes to nothing, never to everything", async () => {
  const { storeId } = await newStore();
  const profile = await seedProfile(storeId);
  const p = await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/8101" });
  await seedOverride(storeId, p.shopifyProductId, profile.id);

  const result = await reconcileCatalogCoverage(prisma, storeId, { onlyProductIds: [] });
  assert.equal(result.scanned, 0);
  assert.equal(result.updated, 0);
  assert.equal((await row(p.id)).coverageStatus, "unassigned", "an empty scope did not turn into a full scan");
});

test("a dry run returns the exact row and column changes and writes nothing", async () => {
  const { storeId } = await newStore();
  const profile = await seedProfile(storeId);
  const linked = await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/8201" });
  await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/8202" });
  await seedOverride(storeId, linked.shopifyProductId, profile.id);

  const dry = await reconcileCatalogCoverage(prisma, storeId, { dryRun: true });
  assert.equal(dry.scanned, 2);
  assert.equal(dry.updated, 1);
  assert.equal(dry.changes?.length, 1);
  const change = dry.changes![0];
  assert.equal(change.productGid, "gid://shopify/Product/8201");
  assert.deepEqual(change.before, { assignedProfileId: null, assignmentSource: null, coverageStatus: "unassigned", enforcementReady: false });
  assert.deepEqual(change.after, { assignedProfileId: profile.id, assignmentSource: "override", coverageStatus: "assigned", enforcementReady: false });
  assert.equal((await row(linked.id)).coverageStatus, "unassigned", "nothing was written");

  const real = await reconcileCatalogCoverage(prisma, storeId);
  assert.equal(real.updated, 1);
  assert.equal(real.changes, undefined, "changes are returned only when asked for");
  const after1 = await row(linked.id);
  assert.equal(after1.coverageStatus, "assigned");
  assert.equal(after1.assignedProfileId, profile.id);
  assert.equal((await reconcileCatalogCoverage(prisma, storeId)).updated, 0, "idempotent");
});

test("enforcementReady stays derived, and policySyncedAt / policyDigest are never written", async () => {
  const { storeId } = await newStore();
  const profile = await seedProfile(storeId);
  const unsynced = await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/8301" });
  const syncedAt = new Date("2026-01-05T00:00:00Z");
  const synced = await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/8302", policySyncedAt: syncedAt });
  await prisma.catalogProduct.update({ where: { id: synced.id }, data: { policyDigest: "digest-kept" } });
  await seedOverride(storeId, unsynced.shopifyProductId, profile.id);
  await seedOverride(storeId, synced.shopifyProductId, profile.id);

  await reconcileCatalogCoverage(prisma, storeId);
  const a = await row(unsynced.id);
  assert.equal(a.coverageStatus, "assigned");
  assert.equal(a.enforcementReady, false, "no policySyncedAt, so not enforcement-ready");
  assert.equal(a.policySyncedAt, null, "reconcile did not invent a policySyncedAt");
  assert.equal(a.policyDigest, null);
  const b = await row(synced.id);
  assert.equal(b.enforcementReady, true, "synced policy + matching currency");
  assert.equal(b.policySyncedAt?.getTime(), syncedAt.getTime(), "policySyncedAt untouched");
  assert.equal(b.policyDigest, "digest-kept", "policyDigest untouched");
});

test("the after-sync scope is exactly: products with an override, plus products currently marked covered", async () => {
  const { storeId } = await newStore();
  const profile = await seedProfile(storeId);
  const withOverride = await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/8401" });
  const staleCovered = await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/8402", coverageStatus: "assigned", assignedProfileId: profile.id });
  const plain = await seedCatalogProduct(storeId, { gid: "gid://shopify/Product/8403" });
  await seedOverride(storeId, withOverride.shopifyProductId, profile.id);

  const result = await reconcileCoverageAfterSync(prisma, storeId);
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 2, "the plain product was not even scanned");
  assert.equal(result.updated, 2);
  assert.equal((await row(withOverride.id)).coverageStatus, "assigned");
  assert.equal((await row(staleCovered.id)).coverageStatus, "unassigned", "covered with no override any more -> reset");
  assert.equal((await row(staleCovered.id)).assignedProfileId, null);
  assert.equal((await row(plain.id)).coverageStatus, "unassigned");
});

test("the best-effort wrappers report a failure instead of throwing, and redact connection strings", async () => {
  const broken = {
    store: {
      findUnique: async () => {
        throw new Error("connect failed for postgresql://user:npg_secretvalue@host.example/db?sslmode=require");
      },
    },
    productPricingOverride: { findMany: async () => { throw new Error("boom postgres://u:p@h/db"); } },
    catalogProduct: { findMany: async () => [] },
  } as unknown as PrismaClient;

  const scoped = await reconcileCoverageForProducts(broken, "store", ["gid://shopify/Product/1"]);
  assert.equal(scoped.ok, false);
  assert.ok(!/npg_|postgres/i.test(String(scoped.error)), String(scoped.error));

  const afterSync = await reconcileCoverageAfterSync(broken, "store");
  assert.equal(afterSync.ok, false);
  assert.ok(!/postgres/i.test(String(afterSync.error)));
});
