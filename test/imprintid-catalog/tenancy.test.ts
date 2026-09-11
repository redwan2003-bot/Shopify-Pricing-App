/**
 * Task 6A §1, §10, §11 — tenancy isolation + LNY01 preservation.
 *
 * Proves: the store is resolved only from a validated `*.myshopify.com` domain; one
 * shop cannot read another's catalog / jobs / coverage; an existing LNY01-style
 * ProductPricingOverride is never touched by catalog code that isn't assigning it.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resolveStoreContext, resolveStoreProducts, CrossTenantError } from "../../app/lib/catalog/tenancy.ts";
import { catalogCoverage } from "../../app/lib/catalog/coverage.ts";
import { queryCatalogPage } from "../../app/lib/catalog/catalog-query.ts";
import { planBulkAssignment } from "../../app/lib/catalog/dry-run.ts";
import { confirmAndCreateJob } from "../../app/lib/catalog/apply.ts";
import { processAssignmentJob } from "../../app/lib/catalog/processor.ts";
import {
  prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride,
  FakeWritePort, ENFORCEMENT_DISABLED,
  overrideKeyFor
} from "./helpers.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

test("resolveStoreContext rejects a non-myshopify domain", async () => {
  await assert.rejects(() => resolveStoreContext(prisma, "evil.example.com"), CrossTenantError);
  await assert.rejects(() => resolveStoreContext(prisma, "'; DROP TABLE Store;--"), CrossTenantError);
});

test("resolveStoreContext resolves the store id ONLY from the passed domain", async () => {
  const domain = makeShopDomain("catalog-tenancy");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const ctx = await resolveStoreContext(prisma, domain);
  assert.ok(ctx);
  assert.equal(ctx.storeId, storeId);
  assert.equal(ctx.shopDomain, domain);
});

test("one shop's coverage / product queries never include another shop's data", async () => {
  const aDomain = makeShopDomain("catalog-tenancy");
  const bDomain = makeShopDomain("catalog-tenancy");
  shops.push(aDomain, bDomain);
  const a = await seedStore(aDomain, "USD");
  const b = await seedStore(bDomain, "USD");

  for (let i = 0; i < 4; i++) await seedCatalogProduct(a, { coverageStatus: "assigned" });
  for (let i = 0; i < 7; i++) await seedCatalogProduct(b);

  const aCov = await catalogCoverage(prisma, a);
  assert.equal(aCov.totalProducts, 4);
  const bCov = await catalogCoverage(prisma, b);
  assert.equal(bCov.totalProducts, 7);

  const aPage = await queryCatalogPage(prisma, a, {});
  assert.equal(aPage.items.length, 4);
});

test("resolveStoreProducts rejects ids that belong to another store", async () => {
  const aDomain = makeShopDomain("catalog-tenancy");
  const bDomain = makeShopDomain("catalog-tenancy");
  shops.push(aDomain, bDomain);
  const a = await seedStore(aDomain, "USD");
  const b = await seedStore(bDomain, "USD");
  const mine = await seedCatalogProduct(a);
  const foreign = await seedCatalogProduct(b);

  const res = await resolveStoreProducts(prisma, a, [mine.shopifyProductId, foreign.shopifyProductId]);
  assert.deepEqual(res.matched.map((m) => m.shopifyProductId), [mine.shopifyProductId]);
  assert.equal(res.rejected[0]!.reason, "unknown");
});

test("a bulk assignment cannot target another shop's profile", async () => {
  const aDomain = makeShopDomain("catalog-tenancy");
  const bDomain = makeShopDomain("catalog-tenancy");
  shops.push(aDomain, bDomain);
  const a = await seedStore(aDomain, "USD");
  const b = await seedStore(bDomain, "USD");
  const bProfile = await seedProfile(b, { name: "B Profile" });
  await seedCatalogProduct(a);

  const r = await planBulkAssignment(prisma, {
    storeId: a, shopDomain: aDomain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: bProfile.id, replaceExisting: false, idempotencyKey: "x",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PROFILE_NOT_FOUND");
});

test("an existing LNY01-style override is untouched by an assignment job for OTHER products", async () => {
  const domain = makeShopDomain("catalog-tenancy");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const lnyProfile = await seedProfile(storeId, { name: "LNY01", sku: "LNY01", currency: "USD" });
  const bulkProfile = await seedProfile(storeId, { name: "Bulk", currency: "USD" });

  // LNY01's product + its pinned override — the thing that must not move.
  const lnyProduct = await seedCatalogProduct(storeId, { title: "LNY01 Product" });
  await seedOverride(storeId, lnyProduct.shopifyProductId, lnyProfile.id, { basePriceCents: 12345 });

  // Other products to bulk-assign.
  const others = [];
  for (let i = 0; i < 3; i++) others.push((await seedCatalogProduct(storeId)).shopifyProductId);

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: others }, pricingProfileId: bulkProfile.id, replaceExisting: false, idempotencyKey: "lny-safe",
  });
  assert.ok(dry.ok);
  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok);
  await processAssignmentJob(prisma, storeId, dry.jobId, { port: new FakeWritePort(), shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });

  const lnyOverride = await prisma.productPricingOverride.findFirstOrThrow({ where: { storeId, shopifyProductId: overrideKeyFor(lnyProduct.shopifyProductId) } });
  assert.equal(lnyOverride.pricingProfileId, lnyProfile.id, "LNY01 override still points at the LNY01 profile");
  assert.equal(lnyOverride.basePriceCents, 12345, "LNY01 override base price unchanged");
  // and no BulkAssignmentItem was ever created for the LNY01 product
  assert.equal(await prisma.bulkAssignmentItem.count({ where: { storeId, shopifyProductId: lnyProduct.shopifyProductId } }), 0);
});
