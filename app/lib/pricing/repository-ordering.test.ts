import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createTestPrisma } from "../../../test/support/prisma.ts";
import { loadPricingContext } from "./repository.ts";

/**
 * Regression: child rows of a PricingProfile must load in a deterministic order on every
 * database engine. The fixture inserts every child collection in a deliberately scrambled
 * order (ids and quantity breaks both out of sequence) so database insertion order can
 * never accidentally satisfy the assertions.
 */
const SUFFIX = `${process.pid}-${Date.now()}`;
const SHOP = `pricing-order-test-${SUFFIX}.invalid`;
const SKU = "ORDER01";

const prisma = createTestPrisma();

after(async () => {
  const store = await prisma.store.findUnique({ where: { shopDomain: SHOP } });
  if (store) {
    const profile = await prisma.pricingProfile.findFirst({ where: { storeId: store.id } });
    if (profile) {
      const groups = await prisma.optionGroup.findMany({ where: { pricingProfileId: profile.id }, select: { id: true } });
      await prisma.optionValue.deleteMany({ where: { optionGroupId: { in: groups.map((g) => g.id) } } });
      const where = { pricingProfileId: profile.id };
      await prisma.optionGroup.deleteMany({ where });
      await prisma.quantityTier.deleteMany({ where });
      await prisma.decorationRule.deleteMany({ where });
      await prisma.decorationColorCharge.deleteMany({ where });
      await prisma.productColor.deleteMany({ where });
      await prisma.productionRule.deleteMany({ where });
      await prisma.packagingRule.deleteMany({ where });
      await prisma.pricingProfile.delete({ where: { id: profile.id } });
    }
    await prisma.store.delete({ where: { id: store.id } });
  }
  await prisma.$disconnect();
});

async function seed(): Promise<void> {
  const store = await prisma.store.create({ data: { shopDomain: SHOP } });
  const profile = await prisma.pricingProfile.create({ data: { storeId: store.id, name: "Order test", sku: SKU } });
  const pricingProfileId = profile.id;
  const money = { listPriceCents: 100, netPriceCents: 80 };

  // Quantity breaks inserted 500, 1, 100 — and with ids that sort differently again.
  await prisma.quantityTier.create({ data: { id: `${SUFFIX}-t-b`, pricingProfileId, minQuantity: 500, ...money } });
  await prisma.quantityTier.create({ data: { id: `${SUFFIX}-t-c`, pricingProfileId, minQuantity: 1, ...money } });
  await prisma.quantityTier.create({ data: { id: `${SUFFIX}-t-a`, pricingProfileId, minQuantity: 100, ...money } });

  for (const k of ["z", "a", "m"]) {
    await prisma.decorationRule.create({ data: { id: `${SUFFIX}-dr-${k}`, pricingProfileId, method: "SCREEN_PRINT", code: `D-${k}`, name: k, chargeBasis: "PER_UNIT", ...money } });
    await prisma.decorationColorCharge.create({ data: { id: `${SUFFIX}-dc-${k}`, pricingProfileId, method: "SCREEN_PRINT", colorNumber: k === "z" ? 3 : k === "a" ? 1 : 2, chargeBasis: "PER_UNIT", ...money } });
    await prisma.productColor.create({ data: { id: `${SUFFIX}-pc-${k}`, pricingProfileId, code: `C-${k}`, name: k } });
    await prisma.productionRule.create({ data: { id: `${SUFFIX}-pr-${k}`, pricingProfileId, code: `P-${k}`, name: k, minBusinessDays: 5 } });
    await prisma.packagingRule.create({ data: { id: `${SUFFIX}-pk-${k}`, pricingProfileId, code: `K-${k}`, name: k } });
  }
  for (const g of ["y", "b", "q"]) {
    const group = await prisma.optionGroup.create({ data: { id: `${SUFFIX}-og-${g}`, pricingProfileId, name: `Group ${g}` } });
    for (const v of ["w", "c", "t"]) {
      await prisma.optionValue.create({ data: { id: `${SUFFIX}-ov-${g}-${v}`, optionGroupId: group.id, label: `Value ${v}` } });
    }
  }
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const sorted = (list: string[]) => [...list].sort();

test("child arrays load in a stable, deterministic order", async () => {
  await seed();
  const { profile } = await loadPricingContext(prisma, { shopDomain: SHOP, sku: SKU });

  assert.deepEqual(profile.quantityTiers.map((t) => t.minQuantity), [1, 100, 500], "tiers ascend by minimum quantity");

  assert.deepEqual(ids(profile.decorationRules), sorted(ids(profile.decorationRules)), "decoration rules in id order");
  assert.deepEqual(ids(profile.decorationColorCharges), sorted(ids(profile.decorationColorCharges)), "colour charges in id order");
  assert.deepEqual(ids(profile.productColors), sorted(ids(profile.productColors)), "product colours in id order");
  assert.deepEqual(ids(profile.productionRules), sorted(ids(profile.productionRules)), "production rules in id order");
  assert.deepEqual(ids(profile.packagingRules), sorted(ids(profile.packagingRules)), "packaging rules in id order");
  assert.deepEqual(ids(profile.optionGroups), sorted(ids(profile.optionGroups)), "option groups in id order");
  for (const g of profile.optionGroups) {
    assert.deepEqual(ids(g.optionValues), sorted(ids(g.optionValues)), `option values of ${g.name} in id order`);
  }
  assert.equal(profile.decorationRules.length, 3);
  assert.equal(profile.optionGroups.length, 3);
  assert.equal(profile.optionGroups[0].optionValues.length, 3);
});

test("loading the same profile twice yields an identical ordered structure", async () => {
  const a = await loadPricingContext(prisma, { shopDomain: SHOP, sku: SKU });
  const b = await loadPricingContext(prisma, { shopDomain: SHOP, sku: SKU });
  assert.equal(JSON.stringify(a.profile), JSON.stringify(b.profile));
});
