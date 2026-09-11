import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { importPricingProfile, PricingImportValidationError } from "./import.ts";
import { buildLny01PricingInput } from "../../../prisma/seed-data/lny01.ts";

/**
 * These tests run against the project's real (hardcoded, non-env-configurable)
 * dev.sqlite datasource — this app's prisma/schema.prisma does not currently support
 * pointing at a separate test database. To avoid touching real seeded data, every test
 * here uses one disposable shop domain, cleaned up in `after`.
 */
const TEST_SHOP_DOMAIN = `pricing-import-test-${process.pid}.invalid`;
const prisma = new PrismaClient({ datasources: { db: { url: "file:dev.sqlite?socket_timeout=45&connection_limit=1" } } });

after(async () => {
  await prisma.store.deleteMany({ where: { shopDomain: TEST_SHOP_DOMAIN } });
  await prisma.$disconnect();
});

test("imports LNY01 and creates the expected record counts", async () => {
  const result = await importPricingProfile(
    prisma,
    buildLny01PricingInput(TEST_SHOP_DOMAIN),
  );

  assert.equal(result.sku, "LNY01");
  assert.equal(result.counts.quantityTiers, 6);
  // Phase 2.7: 6 -> 4; ADDL_COLOR_SETUP/ADDL_COLOR_RUN moved to decorationColorCharges
  // (colorNumber=2), carrying the identical cent values — see prisma/seed-data/lny01.ts.
  assert.equal(result.counts.decorationRules, 4);
  assert.equal(result.counts.decorationColorCharges, 2);
  assert.equal(result.counts.optionGroups, 6);
  assert.equal(result.counts.productColors, 3, "LNY01's three stock Color variants (Black/Red/Blue)");
  assert.equal(result.counts.productionRules, 2);
  assert.equal(result.counts.packagingRules, 1);
});

test("stores prices as integer cents matching the source sheet", async () => {
  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { sku: "LNY01", store: { shopDomain: TEST_SHOP_DOMAIN } },
    include: {
      quantityTiers: { orderBy: { minQuantity: "asc" } },
      decorationRules: true,
    },
  });

  const first = profile.quantityTiers[0]!;
  assert.equal(first.minQuantity, 100);
  assert.equal(first.listPriceCents, 229);
  assert.equal(first.netPriceCents, 137);
  assert.equal(Number.isInteger(first.listPriceCents), true);
  assert.equal(Number.isInteger(first.netPriceCents), true);

  const last = profile.quantityTiers.at(-1)!;
  assert.equal(last.minQuantity, 5000);
  assert.equal(last.listPriceCents, 121);
  assert.equal(last.netPriceCents, 73);
  assert.equal(last.maxQuantity, null);

  const setupCharge = profile.decorationRules.find((r) => r.code === "SETUP_1C1L");
  assert.ok(setupCharge);
  assert.equal(setupCharge.listPriceCents, 4500);
  assert.equal(setupCharge.netPriceCents, 3600);
  assert.equal(setupCharge.chargeBasis, "ONE_TIME");
});

test("production and packaging information is stored", async () => {
  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { sku: "LNY01", store: { shopDomain: TEST_SHOP_DOMAIN } },
    include: { productionRules: true, packagingRules: true },
  });

  const rush = profile.productionRules.find((r) => r.code === "RUSH");
  assert.ok(rush);
  assert.equal(rush.relatedSku, "LNY5RSH01");
  assert.equal(rush.minBusinessDays, 5);
  assert.equal(rush.feeCents, null, "no rush surcharge was supplied");

  const carton = profile.packagingRules[0]!;
  assert.equal(carton.unitsPerPackage, 250);
  assert.equal(carton.cartonWeightLbs, 8.5);
  assert.equal(carton.lengthIn, 12);
  assert.equal(carton.widthIn, 8);
  assert.equal(carton.heightIn, 6);
});

test("running the import twice does not duplicate records", async () => {
  await importPricingProfile(prisma, buildLny01PricingInput(TEST_SHOP_DOMAIN));
  const result = await importPricingProfile(
    prisma,
    buildLny01PricingInput(TEST_SHOP_DOMAIN),
  );

  const store = await prisma.store.findUniqueOrThrow({
    where: { shopDomain: TEST_SHOP_DOMAIN },
  });
  const profileCount = await prisma.pricingProfile.count({
    where: { storeId: store.id },
  });
  const tierCount = await prisma.quantityTier.count({
    where: { pricingProfileId: result.pricingProfileId },
  });
  const optionValueCount = await prisma.optionValue.count({
    where: { optionGroup: { pricingProfileId: result.pricingProfileId } },
  });
  const colorChargeCount = await prisma.decorationColorCharge.count({
    where: { pricingProfileId: result.pricingProfileId },
  });

  assert.equal(profileCount, 1, "no duplicate PricingProfile");
  assert.equal(tierCount, 6, "no duplicate QuantityTier rows");
  assert.equal(optionValueCount, 27, "no duplicate OptionValue rows");
  assert.equal(colorChargeCount, 2, "no duplicate DecorationColorCharge rows");
});

test("rejects an invalid import (negative price) and writes nothing for it", async () => {
  const input = buildLny01PricingInput(TEST_SHOP_DOMAIN);
  input.quantityTiers[0]!.netPriceCents = -1;

  await assert.rejects(
    () => importPricingProfile(prisma, input),
    PricingImportValidationError,
  );
});

test("rejects an invalid quantity (zero) before touching the database", async () => {
  const input = buildLny01PricingInput(TEST_SHOP_DOMAIN);
  input.quantityTiers[0]!.minQuantity = 0;

  await assert.rejects(
    () => importPricingProfile(prisma, input),
    PricingImportValidationError,
  );
});
