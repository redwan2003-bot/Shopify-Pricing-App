import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { loadPricingCatalog } from "./catalog.ts";
import { PricingProfileNotFound, StoreNotFound } from "../pricing/index.ts";

const SHOP_DOMAIN = "imprintid-pricing-development.myshopify.com";
const SKU = "LNY01";

const prisma = new PrismaClient();

after(async () => {
  await prisma.$disconnect();
});

test("loads the real LNY01 catalog: quantity tiers", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  assert.equal(catalog.sku, "LNY01");
  assert.deepEqual(
    catalog.quantityTiers.map((t) => t.minQuantity),
    [100, 300, 500, 1000, 3000, 5000],
  );
  assert.equal(catalog.quantityTiers[0]!.listUnitPriceCents, 229);
  assert.equal(catalog.quantityTiers[0]!.netUnitPriceCents, 137);
});

test("loads the real LNY01 catalog: decoration methods", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  assert.deepEqual(catalog.decorationMethods, ["SCREEN_PRINT"]);
});

test("loads the real LNY01 catalog: option groups and values, with real ids and no invented prices", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  assert.equal(catalog.optionGroups.length, 6);

  const standard = catalog.optionGroups.find((g) => g.name === "Attachment — Standard")!;
  assert.equal(standard.categoryPriceAdjustmentCents, 0);
  const jHook = standard.values.find((v) => v.label === "J Hook")!;
  assert.match(jHook.id, /^c/); // a real cuid, not a placeholder
  assert.equal(jHook.priceAdjustmentCents, null); // never invented

  const features = catalog.optionGroups.find((g) => g.name === "Optional Features")!;
  const cellPhoneLoop = features.values.find((v) => v.label === "Cell Phone Loop")!;
  assert.equal(cellPhoneLoop.priceAdjustmentCents, 25);
});

test("loads the real LNY01 catalog: production rules including RUSH's relatedSku", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  const rush = catalog.productionRules.find((r) => r.code === "RUSH")!;
  assert.equal(rush.relatedSku, "LNY5RSH01");
  assert.equal(rush.feeCents, null);
});

test("Phase 2.7: option groups expose `kind` so Attachment/Feature can be told apart without name matching", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  const attachmentGroups = catalog.optionGroups.filter((g) => g.kind === "ATTACHMENT");
  const featureGroups = catalog.optionGroups.filter((g) => g.kind === "FEATURE");
  assert.equal(attachmentGroups.length, 5);
  assert.equal(featureGroups.length, 1);
  assert.equal(featureGroups[0]!.name, "Optional Features");
});

test("Phase 2.7: LNY01 has no product colors — documented absence, an empty array, never invented", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  assert.deepEqual(catalog.productColors, []);
});

test("Phase 2.7: decoration color charges expose the real per-color-2 pricing, sorted by color number", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  assert.equal(catalog.decorationColorCharges.length, 2);
  assert.deepEqual(
    catalog.decorationColorCharges.map((c) => c.colorNumber),
    [2, 2],
  );
  const setup = catalog.decorationColorCharges.find((c) => c.chargeBasis === "ONE_TIME")!;
  const run = catalog.decorationColorCharges.find((c) => c.chargeBasis === "PER_UNIT")!;
  assert.equal(setup.listPriceCents, 3500);
  assert.equal(setup.netPriceCents, 2800);
  assert.equal(run.listPriceCents, 25);
  assert.equal(run.netPriceCents, 20);
});

test("Phase 2.7: priceCode is null throughout LNY01's catalog — none was ever sourced, none was invented", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  assert.ok(catalog.quantityTiers.every((t) => t.priceCode === null));
  assert.ok(catalog.decorationColorCharges.every((c) => c.priceCode === null));
  for (const group of catalog.optionGroups) {
    assert.ok(group.values.every((v) => v.priceCode === null));
  }
});

// Real-data trace, per every documented attachment category — mirrors exactly what
// `dynamic-pricing.js` now renders next to each option, and exactly what
// `calculatePrice()` would charge if that option were selected (see
// calculator.test.ts's "resolveOptionValuePrice" and "options" describe blocks —
// same function, same numbers, proven from both directions).
test("resolvedPriceCents/priceSource: every real LNY01 attachment category resolves to its documented category price", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  const expected: Record<string, number> = {
    "Attachment — Standard": 0,
    "Attachment — Heavy Duty": 23,
    "Attachment — Dual": 20,
    "Attachment — Plastic": 20,
    "Attachment — Black Metal": 20,
  };

  for (const [groupName, categoryCents] of Object.entries(expected)) {
    const group = catalog.optionGroups.find((g) => g.name === groupName)!;
    assert.ok(group, `expected a group named "${groupName}"`);
    assert.equal(group.categoryPriceAdjustmentCents, categoryCents);
    assert.ok(group.values.length > 0);
    for (const value of group.values) {
      // Every real attachment OptionValue has no item-level price — resolution must
      // fall back to the category price, exactly as calculatePrice() would.
      assert.equal(value.priceAdjustmentCents, null);
      assert.equal(value.resolvedPriceCents, categoryCents);
      assert.equal(value.priceSource, "category");
    }
  }
});

test("resolvedPriceCents/priceSource: real Optional Features items resolve to their own item-level price, not the (nonexistent) category price", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  const features = catalog.optionGroups.find((g) => g.name === "Optional Features")!;
  assert.equal(features.categoryPriceAdjustmentCents, null); // no category price for this group at all

  const expected: Record<string, number> = {
    "Buckle Release": 30,
    "Swivel Buckle Release": 25,
    "Velcro Breakaway": 20,
    "Metal Buckle Release": 125,
    "Safety Breakaway": 25,
    "Cell Phone Loop": 25,
  };

  for (const [label, cents] of Object.entries(expected)) {
    const value = features.values.find((v) => v.label === label)!;
    assert.ok(value, `expected an Optional Features item labeled "${label}"`);
    assert.equal(value.priceAdjustmentCents, cents);
    assert.equal(value.resolvedPriceCents, cents);
    assert.equal(value.priceSource, "option");
  }
});

test("resolvedPriceCents/priceSource: a confirmed $0 category price is reported as 0/\"category\", not \"unavailable\"", async () => {
  const catalog = await loadPricingCatalog(prisma, SHOP_DOMAIN, SKU);
  const standard = catalog.optionGroups.find((g) => g.name === "Attachment — Standard")!;
  for (const value of standard.values) {
    assert.equal(value.resolvedPriceCents, 0);
    assert.notEqual(value.priceSource, "unavailable");
  }
});

test("an unknown SKU raises the same PricingProfileNotFound calculatePrice would", async () => {
  await assert.rejects(
    () => loadPricingCatalog(prisma, SHOP_DOMAIN, "NO-SUCH-SKU"),
    PricingProfileNotFound,
  );
});

test("an unknown shop raises the same StoreNotFound calculatePrice would", async () => {
  await assert.rejects(
    () => loadPricingCatalog(prisma, "no-such-shop.invalid", SKU),
    StoreNotFound,
  );
});
