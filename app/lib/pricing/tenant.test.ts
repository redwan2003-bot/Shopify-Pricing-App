import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestPrisma } from "../../../test/support/prisma.ts";
import { calculatePrice } from "./index.ts";
import { PricingConfigurationInvalid, PricingProfileNotFound, StoreNotFound } from "./errors.ts";
import { importPricingProfile } from "../pricing-import/import.ts";
import type { PricingProfileImportInput } from "../pricing-import/types.ts";

/**
 * Store isolation and ProductPricingOverride precedence. These need synthetic data
 * (two stores that intentionally share a SKU, plus a hand-built override row), so —
 * like Phase 2.2's own tests — everything here runs against disposable stores in the
 * project's real dev.sqlite, cleaned up in `after`. Reuses the existing
 * `importPricingProfile` import architecture from Phase 2.2 to set up fixture data,
 * rather than inventing a second way to write pricing rows.
 */
const SUFFIX = `${process.pid}-${Date.now()}`;
const STORE_A_DOMAIN = `pricing-engine-test-a-${SUFFIX}.invalid`;
const STORE_B_DOMAIN = `pricing-engine-test-b-${SUFFIX}.invalid`;
const SHARED_SKU = "SHARED01";
const OVERRIDE_SKU = "SHARED01-OVERRIDE";
const SHOPIFY_PRODUCT_ID = "gid://shopify/Product/999999";

const prisma = createTestPrisma();

function minimalImport(
  shopDomain: string,
  sku: string,
  price: { list: number; net: number },
): PricingProfileImportInput {
  return {
    shopDomain,
    sku,
    name: `Tenant test product ${sku}`,
    quantityTiers: [{ minQuantity: 10, listPriceCents: price.list, netPriceCents: price.net }],
    decorationRules: [],
    optionGroups: [],
    productionRules: [{ code: "STANDARD", name: "Standard", minBusinessDays: 5 }],
    packagingRules: [{ code: "CARTON", name: "Carton" }],
  };
}

let storeAId: string;
let overrideProfileId: string;

before(async () => {
  await importPricingProfile(prisma, minimalImport(STORE_A_DOMAIN, SHARED_SKU, { list: 1000, net: 900 }));
  await importPricingProfile(prisma, minimalImport(STORE_B_DOMAIN, SHARED_SKU, { list: 2000, net: 1900 }));
  const overrideImport = await importPricingProfile(
    prisma,
    minimalImport(STORE_A_DOMAIN, OVERRIDE_SKU, { list: 5000, net: 4900 }),
  );
  overrideProfileId = overrideImport.pricingProfileId;
  storeAId = overrideImport.storeId;

  await prisma.productPricingOverride.create({
    data: {
      storeId: storeAId,
      shopifyProductId: SHOPIFY_PRODUCT_ID,
      pricingProfileId: overrideProfileId,
      isActive: true,
    },
  });
  await prisma.productPricingOverride.create({
    data: {
      storeId: storeAId,
      shopifyProductId: "gid://shopify/Product/inactive",
      pricingProfileId: overrideProfileId,
      isActive: false,
    },
  });
});

after(async () => {
  await prisma.store.deleteMany({ where: { shopDomain: { in: [STORE_A_DOMAIN, STORE_B_DOMAIN] } } });
  await prisma.$disconnect();
});

test("32. resolves pricing for the correct store + SKU", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: STORE_A_DOMAIN,
    sku: SHARED_SKU,
    quantity: 10,
  });
  assert.equal(result.base.listUnitPriceCents, 1000);
  assert.equal(result.base.netUnitPriceCents, 900);
});

test("33. the same SKU in a different store returns that store's own pricing, never the other store's", async () => {
  const fromA = await calculatePrice(prisma, { shopDomain: STORE_A_DOMAIN, sku: SHARED_SKU, quantity: 10 });
  const fromB = await calculatePrice(prisma, { shopDomain: STORE_B_DOMAIN, sku: SHARED_SKU, quantity: 10 });

  assert.equal(fromA.base.listUnitPriceCents, 1000);
  assert.equal(fromB.base.listUnitPriceCents, 2000);
  assert.notEqual(fromA.source.storeId, fromB.source.storeId);
  assert.notEqual(fromA.source.pricingProfileId, fromB.source.pricingProfileId);
});

test("an unknown shop domain is a clear StoreNotFound error", async () => {
  await assert.rejects(
    () => calculatePrice(prisma, { shopDomain: "no-such-shop.invalid", sku: SHARED_SKU, quantity: 10 }),
    StoreNotFound,
  );
});

test("34. a SKU with no pricing profile in an otherwise-valid store is a clear error", async () => {
  await assert.rejects(
    () =>
      calculatePrice(prisma, { shopDomain: STORE_A_DOMAIN, sku: "NO-SUCH-SKU", quantity: 10 }),
    PricingProfileNotFound,
  );
});

test("37. with no shopifyProductId, resolution falls back to the SKU-based profile", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: STORE_A_DOMAIN,
    sku: SHARED_SKU,
    quantity: 10,
  });
  assert.equal(result.source.resolvedVia, "sku");
  assert.equal(result.base.listUnitPriceCents, 1000);
});

test("38. an active ProductPricingOverride takes precedence over the SKU lookup", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: STORE_A_DOMAIN,
    sku: SHARED_SKU, // deliberately the "wrong" sku — the override should win outright
    shopifyProductId: SHOPIFY_PRODUCT_ID,
    quantity: 10,
  });
  assert.equal(result.source.resolvedVia, "override");
  assert.equal(result.source.pricingProfileId, overrideProfileId);
  assert.equal(result.base.listUnitPriceCents, 5000);
});

test("an inactive ProductPricingOverride is rejected rather than silently ignored", async () => {
  await assert.rejects(
    () =>
      calculatePrice(prisma, {
        shopDomain: STORE_A_DOMAIN,
        sku: SHARED_SKU,
        shopifyProductId: "gid://shopify/Product/inactive",
        quantity: 10,
      }),
    PricingConfigurationInvalid,
  );
});
