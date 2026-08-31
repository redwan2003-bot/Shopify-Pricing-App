import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient, DecorationMethod } from "@prisma/client";
import { calculatePrice } from "./index.ts";

/**
 * These tests calculate against the *real* seeded LNY01 pricing profile in the
 * project's dev.sqlite (see prisma/seed-data/lny01.ts / prisma/seed.ts) — not a
 * fixture. The expected totals below are computed by hand from the same source sheet
 * the seed data was transcribed from (see prisma/seed-data/README.md), so if the
 * database's LNY01 pricing is ever changed without updating these numbers, these
 * tests fail — that's the point: it demonstrates the engine is genuinely
 * database-driven, not hardcoded.
 */
const SHOP_DOMAIN = "imprintid-pricing-development.myshopify.com";
const SKU = "LNY01";

const prisma = new PrismaClient();

let cellPhoneLoopId: string;
let standardAttachmentId: string;

before(async () => {
  const cellPhoneLoop = await prisma.optionValue.findFirstOrThrow({
    where: { label: "Cell Phone Loop", optionGroup: { name: "Optional Features" } },
  });
  cellPhoneLoopId = cellPhoneLoop.id;

  const standardAttachment = await prisma.optionValue.findFirstOrThrow({
    where: { label: "J Hook", optionGroup: { name: "Attachment — Standard" } },
  });
  standardAttachmentId = standardAttachment.id;
});

after(async () => {
  await prisma.$disconnect();
});

test("LNY01 base pricing at quantity 100 matches the source sheet (list $2.29 / net $1.37)", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: SHOP_DOMAIN,
    sku: SKU,
    quantity: 100,
  });

  assert.equal(result.source.resolvedVia, "sku");
  assert.equal(result.source.pricingProfileSku, "LNY01");
  assert.equal(result.quantityTier.minQuantity, 100);
  assert.equal(result.base.listUnitPriceCents, 229);
  assert.equal(result.base.netUnitPriceCents, 137);
  assert.equal(result.base.listSubtotalCents, 22900);
  assert.equal(result.base.netSubtotalCents, 13700);
  assert.deepEqual(
    result.availableQuantityTiers.map((t) => t.minQuantity),
    [100, 300, 500, 1000, 3000, 5000],
  );
  // No decoration/options requested, and both STANDARD production and the standard
  // carton have no fee configured, so totals equal the base subtotal exactly.
  assert.equal(result.totals.listTotalCents, 22900);
  assert.equal(result.totals.netTotalCents, 13700);
});

test("LNY01 quantity 750 selects the 500 tier (highest minQuantity <= 750)", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: SHOP_DOMAIN,
    sku: SKU,
    quantity: 750,
  });
  assert.equal(result.quantityTier.minQuantity, 500);
  assert.equal(result.base.listUnitPriceCents, 189);
  assert.equal(result.base.netUnitPriceCents, 113);
});

test("LNY01 quantity 5000 matches the top tier (list $1.21 / net $0.73)", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: SHOP_DOMAIN,
    sku: SKU,
    quantity: 5000,
  });
  assert.equal(result.base.listUnitPriceCents, 121);
  assert.equal(result.base.netUnitPriceCents, 73);
});

test("LNY01 base setup decoration at quantity 500 (one color, one location)", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: SHOP_DOMAIN,
    sku: SKU,
    quantity: 500,
    decoration: {
      method: DecorationMethod.SCREEN_PRINT,
      colors: 1,
      locations: 1,
      reverseSide: false,
      differentReverseArtwork: false,
      repeatOrder: false,
    },
  });

  assert.equal(result.decoration!.charges.length, 1);
  assert.equal(result.decoration!.charges[0]!.code, "SETUP_1C1L");
  assert.equal(result.decoration!.listChargesCents, 4500);
  assert.equal(result.decoration!.netChargesCents, 3600);
  // base (500 tier): list 189 * 500 = 94500, net 113 * 500 = 56500
  assert.equal(result.totals.listTotalCents, 94500 + 4500);
  assert.equal(result.totals.netTotalCents, 56500 + 3600);
});

test("LNY01 full configuration: 2 colors, 2 locations, different reverse art, repeat order, an option, rush production", async () => {
  const quantity = 1000;
  const result = await calculatePrice(prisma, {
    shopDomain: SHOP_DOMAIN,
    sku: SKU,
    quantity,
    decoration: {
      method: DecorationMethod.SCREEN_PRINT,
      colors: 2,
      locations: 2,
      reverseSide: true,
      differentReverseArtwork: true,
      repeatOrder: true,
    },
    options: [{ groupName: "Optional Features", optionValueId: cellPhoneLoopId }],
    production: { code: "RUSH" },
  });

  // Phase 2.7 regression: ADDL_COLOR_SETUP/ADDL_COLOR_RUN were replaced by
  // DecorationColorCharge rows for colorNumber=2 (see prisma/seed-data/lny01.ts) — the
  // line-item codes below changed (COLOR_2_SETUP/COLOR_2_RUN), but every cent value,
  // and therefore the final totals, are byte-identical to what this test asserted
  // before Phase 2.7.
  const codes = result.decoration!.charges.map((c) => c.code).sort();
  assert.deepEqual(codes, [
    "COLOR_2_RUN",
    "COLOR_2_SETUP",
    "REPEAT_ORDER_SETUP",
    "REVERSE_SIDE_SETUP",
    "SECOND_LOCATION_RUN",
    "SETUP_1C1L",
  ]);

  // Hand-computed from the source sheet (see prisma/seed-data/lny01.ts for each code's
  // list/net cents): one-time charges (SETUP_1C1L 4500/3600, COLOR_2_SETUP 3500/2800,
  // REVERSE_SIDE_SETUP 4000/3200, REPEAT_ORDER_SETUP 2500/2000) each count once;
  // per-unit charges (COLOR_2_RUN 25/20, SECOND_LOCATION_RUN 30/24) each count 1000
  // times — identical arithmetic to the pre-Phase-2.7 ADDL_COLOR_* rules.
  const expectedListDecoration = 4500 + 3500 + 4000 + 2500 + 25 * quantity + 30 * quantity;
  const expectedNetDecoration = 3600 + 2800 + 3200 + 2000 + 20 * quantity + 24 * quantity;
  assert.equal(result.decoration!.listChargesCents, expectedListDecoration);
  assert.equal(result.decoration!.netChargesCents, expectedNetDecoration);

  assert.equal(result.options.chargesCents, 25); // Cell Phone Loop: +$0.25
  assert.equal(result.production.code, "RUSH");
  assert.equal(result.production.relatedSku, "LNY5RSH01");
  assert.equal(result.production.minBusinessDays, 5);

  const listUnit = result.base.listUnitPriceCents;
  const netUnit = result.base.netUnitPriceCents;
  const listTotal = listUnit * quantity + expectedListDecoration + 25;
  const netTotal = netUnit * quantity + expectedNetDecoration + 25;

  // The exact figures independently verified in Phases 2.3, 2.4, 2.5, and 2.6 — this
  // is the literal regression proof Phase 2.7 requires: same total, transformed
  // representation.
  assert.equal(listTotal, 233525);
  assert.equal(netTotal, 153625);
  assert.equal(result.totals.listTotalCents, listTotal);
  assert.equal(result.totals.netTotalCents, netTotal);
});

test("LNY01 requesting 3 colors is a clear, honest gap — no color-3 pricing was ever sourced", async () => {
  await assert.rejects(
    () =>
      calculatePrice(prisma, {
        shopDomain: SHOP_DOMAIN,
        sku: SKU,
        quantity: 1000,
        decoration: {
          method: DecorationMethod.SCREEN_PRINT,
          colors: 3,
          locations: 1,
          reverseSide: false,
          differentReverseArtwork: false,
          repeatOrder: false,
        },
      }),
    { name: "ColorPricingUnavailable" },
  );
});

test("LNY01 has no product colors configured — documented absence, not an error", async () => {
  const result = await calculatePrice(prisma, { shopDomain: SHOP_DOMAIN, sku: SKU, quantity: 100 });
  assert.equal(result.productColor, null);
});

test("LNY01 standard attachment option resolves through the category price (source: category, $0)", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: SHOP_DOMAIN,
    sku: SKU,
    quantity: 100,
    options: [{ groupName: "Attachment — Standard", optionValueId: standardAttachmentId }],
  });

  assert.equal(result.options.selections[0]!.source, "category");
  assert.equal(result.options.selections[0]!.priceAdjustmentCents, 0);
  assert.equal(result.options.chargesCents, 0);
});

test("LNY01 packaging information matches the seed data (250/carton, 8.5 lb, 12x8x6 in)", async () => {
  const result = await calculatePrice(prisma, {
    shopDomain: SHOP_DOMAIN,
    sku: SKU,
    quantity: 100,
  });

  assert.equal(result.packaging!.code, "STANDARD_CARTON");
  assert.equal(result.packaging!.unitsPerPackage, 250);
  assert.equal(result.packaging!.cartonWeightLbs, 8.5);
  assert.equal(result.packaging!.lengthIn, 12);
  assert.equal(result.packaging!.widthIn, 8);
  assert.equal(result.packaging!.heightIn, 6);
  assert.equal(result.packaging!.feeCents, null); // no packaging fee was ever supplied
});

test("calling the engine twice against the live database produces an identical result", async () => {
  const input = {
    shopDomain: SHOP_DOMAIN,
    sku: SKU,
    quantity: 300,
    production: { code: "STANDARD" },
  };
  const first = await calculatePrice(prisma, input);
  const second = await calculatePrice(prisma, input);
  assert.deepEqual(first, second);
});
