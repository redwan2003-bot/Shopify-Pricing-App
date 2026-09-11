/**
 * Task 6A §4, §11, §12 — server-side search / filter / cursor pagination.
 *
 * Proves the browser never receives the full catalog: a large synthetic catalog is
 * paged with a bounded `take`, every filter narrows server-side, and a whole page's
 * JSON stays small.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { queryCatalogPage, buildCatalogWhere, catalogFacets } from "../../app/lib/catalog/catalog-query.ts";
import { prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct } from "./helpers.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

async function newStore() {
  const domain = makeShopDomain("catalog-query");
  shops.push(domain);
  return seedStore(domain, "USD");
}

test("cursor pagination returns a bounded page and a resumable cursor, never the whole catalog", async () => {
  const storeId = await newStore();
  for (let i = 0; i < 120; i++) {
    await seedCatalogProduct(storeId, { title: `Item ${String(i).padStart(3, "0")}` });
  }

  const page1 = await queryCatalogPage(prisma, storeId, {}, { pageSize: 25 });
  assert.equal(page1.items.length, 25, "page is capped at the requested size");
  assert.ok(page1.nextCursor, "a next cursor is returned");

  const page2 = await queryCatalogPage(prisma, storeId, {}, { pageSize: 25, cursor: page1.nextCursor });
  assert.equal(page2.items.length, 25);
  const overlap = page1.items.filter((a) => page2.items.some((b) => b.id === a.id));
  assert.equal(overlap.length, 0, "pages do not overlap");

  // A whole page serialized stays small — the browser never gets 120 rows.
  const bytes = Buffer.byteLength(JSON.stringify(page1));
  assert.ok(bytes < 12_000, `page payload ${bytes} bytes is small`);
});

test("pageSize is clamped to MAX_PAGE_SIZE", async () => {
  const storeId = await newStore();
  for (let i = 0; i < 10; i++) await seedCatalogProduct(storeId);
  const page = await queryCatalogPage(prisma, storeId, {}, { pageSize: 100_000 });
  assert.ok(page.pageSize <= 200);
});

test("filters narrow the result set server-side", async () => {
  const storeId = await newStore();
  const profile = await seedProfile(storeId, { name: "Wholesale" });
  await seedCatalogProduct(storeId, { title: "Red Hoodie", vendor: "Acme", productType: "Apparel", status: "ACTIVE", tags: "sale,featured", hasAnySku: true });
  await seedCatalogProduct(storeId, { title: "Blue Mug", vendor: "Globex", productType: "Drinkware", status: "DRAFT", coverageStatus: "assigned", assignedProfileId: profile.id });
  await seedCatalogProduct(storeId, { title: "Green Cap", vendor: "Acme", productType: "Headwear", status: "ARCHIVED" });

  assert.equal((await queryCatalogPage(prisma, storeId, { text: "hoodie" })).items.length, 1);
  assert.equal((await queryCatalogPage(prisma, storeId, { vendor: "Acme" })).items.length, 2);
  assert.equal((await queryCatalogPage(prisma, storeId, { shopifyStatus: "draft" })).items.length, 1);
  assert.equal((await queryCatalogPage(prisma, storeId, { coverageStatus: "assigned" })).items.length, 1);
  assert.equal((await queryCatalogPage(prisma, storeId, { pricingProfileId: profile.id })).items.length, 1);
  assert.equal((await queryCatalogPage(prisma, storeId, { tag: "featured" })).items.length, 1);
  assert.equal((await queryCatalogPage(prisma, storeId, { productType: "Headwear" })).items.length, 1);

  const facets = await catalogFacets(prisma, storeId);
  assert.deepEqual(facets.vendors.sort(), ["Acme", "Globex"]);
});

test("an unparseable product-id filter yields zero rows, never an error", async () => {
  const storeId = await newStore();
  await seedCatalogProduct(storeId);
  const page = await queryCatalogPage(prisma, storeId, { productId: "'; DROP TABLE CatalogProduct; --" });
  assert.equal(page.items.length, 0);
});

test("buildCatalogWhere always pins storeId and excludes removed rows by default", () => {
  const where = buildCatalogWhere("store-x", { text: "abc" });
  assert.equal(where.storeId, "store-x");
  assert.equal(where.removedFromShopifyAt, null);
  const withRemoved = buildCatalogWhere("store-x", { includeRemoved: true });
  assert.equal(withRemoved.removedFromShopifyAt, undefined);
});

test("a filter query for one store never returns another store's products", async () => {
  const a = await newStore();
  const b = await newStore();
  await seedCatalogProduct(a, { title: "Shared Name", vendor: "SameVendor" });
  await seedCatalogProduct(b, { title: "Shared Name", vendor: "SameVendor" });

  const page = await queryCatalogPage(prisma, a, { text: "Shared", vendor: "SameVendor" });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.shopifyProductId, (await prisma.catalogProduct.findFirstOrThrow({ where: { storeId: a } })).shopifyProductId);
});
