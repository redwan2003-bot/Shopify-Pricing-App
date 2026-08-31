import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { handlePricingApiRequest } from "./handler.ts";
import { importPricingProfile } from "../pricing-import/import.ts";
import type { PricingProfileImportInput } from "../pricing-import/types.ts";

/**
 * Exercises the pricing API's core logic end to end — request parsing, the real
 * Phase 2.3 `calculatePrice` engine, and error-to-status mapping — against the real
 * dev.sqlite database. The successful-calculation cases use the actual seeded LNY01
 * profile (see prisma/seed-data/lny01.ts); a few error cases need synthetic profiles
 * (an inactive profile, a required option group) that don't exist in the real LNY01
 * data, so those use disposable stores set up via the existing Phase 2.2 import
 * architecture, cleaned up in `after` — the same pattern already used by
 * app/lib/pricing/tenant.test.ts.
 *
 * `handlePricingApiRequest` takes `shopDomain` as an explicit parameter completely
 * separate from `rawBody` — there is no code path here through which a request body
 * could influence which store gets priced. That is what the tenant-isolation test
 * below demonstrates directly, and it's also the structural reason an "unauthenticated
 * / spoofed shop" attack isn't possible at this layer: the caller (the real route)
 * is the only thing that decides `shopDomain`, and it takes that from the
 * authenticated Shopify session, never from `rawBody`.
 */
const SHOP_DOMAIN = "imprintid-pricing-development.myshopify.com";
const SKU = "LNY01";

const prisma = new PrismaClient();

const SUFFIX = `${process.pid}-${Date.now()}`;
const REQUIRED_GROUP_DOMAIN = `pricing-api-test-required-${SUFFIX}.invalid`;
const INACTIVE_DOMAIN = `pricing-api-test-inactive-${SUFFIX}.invalid`;
const TENANT_A_DOMAIN = `pricing-api-test-tenant-a-${SUFFIX}.invalid`;
const TENANT_B_DOMAIN = `pricing-api-test-tenant-b-${SUFFIX}.invalid`;

function minimalImport(
  shopDomain: string,
  sku: string,
  extra: Partial<PricingProfileImportInput> = {},
): PricingProfileImportInput {
  return {
    shopDomain,
    sku,
    name: `API test product ${sku}`,
    quantityTiers: [{ minQuantity: 10, listPriceCents: 500, netPriceCents: 400 }],
    decorationRules: [],
    optionGroups: [],
    productionRules: [{ code: "STANDARD", name: "Standard", minBusinessDays: 5 }],
    packagingRules: [{ code: "CARTON", name: "Carton" }],
    ...extra,
  };
}

let inactiveProfileSku: string;

before(async () => {
  await importPricingProfile(
    prisma,
    minimalImport(REQUIRED_GROUP_DOMAIN, "REQ01", {
      optionGroups: [
        {
          name: "Must Pick One",
          isRequired: true,
          values: [{ label: "Only Choice", priceAdjustmentCents: 0 }],
        },
      ],
    }),
  );

  inactiveProfileSku = "INACTIVE01";
  const inactiveImport = await importPricingProfile(
    prisma,
    minimalImport(INACTIVE_DOMAIN, inactiveProfileSku),
  );
  await prisma.pricingProfile.update({
    where: { id: inactiveImport.pricingProfileId },
    data: { isActive: false },
  });

  await importPricingProfile(prisma, minimalImport(TENANT_A_DOMAIN, "SHARED", { quantityTiers: [{ minQuantity: 10, listPriceCents: 1000, netPriceCents: 900 }] }));
  await importPricingProfile(prisma, minimalImport(TENANT_B_DOMAIN, "SHARED", { quantityTiers: [{ minQuantity: 10, listPriceCents: 2000, netPriceCents: 1900 }] }));
});

after(async () => {
  await prisma.store.deleteMany({
    where: { shopDomain: { in: [REQUIRED_GROUP_DOMAIN, INACTIVE_DOMAIN, TENANT_A_DOMAIN, TENANT_B_DOMAIN] } },
  });
  await prisma.$disconnect();
});

// --- 1. Successful LNY01 calculation, against the real seeded data -----------------

test("1. a successful LNY01 calculation returns 200 with the real database's pricing", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100 });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.equal(result.body.data.base.listUnitPriceCents, 229);
    assert.equal(result.body.data.base.netUnitPriceCents, 137);
    assert.equal(result.body.data.totals.listTotalCents, 22900);
    assert.equal(result.body.data.totals.netTotalCents, 13700);
  }
});

test("a full LNY01 request (decoration + options + production) returns a fully itemized 200", async () => {
  const optionValue = await prisma.optionValue.findFirstOrThrow({
    where: { label: "Cell Phone Loop", optionGroup: { name: "Optional Features" } },
  });

  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, {
    sku: SKU,
    quantity: 1000,
    decoration: {
      method: "SCREEN_PRINT",
      colors: 2,
      locations: 2,
      reverseSide: true,
      differentReverseArtwork: true,
      repeatOrder: true,
    },
    options: [{ groupName: "Optional Features", optionValueId: optionValue.id }],
    production: { code: "RUSH" },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.equal(result.body.data.totals.listTotalCents, 233525);
    assert.equal(result.body.data.totals.netTotalCents, 153625);
    assert.equal(result.body.data.production.code, "RUSH");
  }
});

// --- 2-3. Request-shape errors -----------------------------------------------------

test("2. missing SKU returns 400 with a boundary validation issue", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, { quantity: 100 });
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  if (!result.body.ok) {
    assert.equal(result.body.error.code, "INVALID_REQUEST_BODY");
    assert.ok(result.body.error.issues?.some((i) => i.path === "sku"));
  }
});

test("3. an invalid quantity type returns 400", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: "one hundred" });
  assert.equal(result.status, 400);
});

// --- 4-8. Domain/engine errors, mapped to 422 --------------------------------------

test("4. quantity below the minimum tier returns 422 with the engine's real error code", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 5 });
  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false);
  if (!result.body.ok) {
    assert.equal(result.body.error.code, "QUANTITY_BELOW_MINIMUM");
  }
});

test("5. an invalid decoration selection returns 422", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, {
    sku: SKU,
    quantity: 100,
    decoration: { method: "SCREEN_PRINT", colors: 0, locations: 1, reverseSide: false, differentReverseArtwork: false, repeatOrder: false },
  });
  assert.equal(result.status, 422);
  if (!result.body.ok) assert.equal(result.body.error.code, "INVALID_DECORATION_SELECTION");
});

test("6. an invalid option value returns 422", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, {
    sku: SKU,
    quantity: 100,
    options: [{ groupName: "Optional Features", optionValueId: "not-a-real-id" }],
  });
  assert.equal(result.status, 422);
  if (!result.body.ok) assert.equal(result.body.error.code, "INVALID_OPTION_VALUE");
});

test("7. a missing required option group returns 422", async () => {
  const result = await handlePricingApiRequest(prisma, REQUIRED_GROUP_DOMAIN, { sku: "REQ01", quantity: 10 });
  assert.equal(result.status, 422);
  if (!result.body.ok) assert.equal(result.body.error.code, "MISSING_REQUIRED_OPTION_GROUP");
});

test("8. an invalid production selection returns 422", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, {
    sku: SKU,
    quantity: 100,
    production: { code: "NEXT_DAY_MAGIC" },
  });
  assert.equal(result.status, 422);
  if (!result.body.ok) assert.equal(result.body.error.code, "PRODUCTION_RULE_NOT_FOUND");
});

// --- 9-10. Not-found errors, mapped to 404 -----------------------------------------

test("9. an unknown pricing profile (SKU) returns 404", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, { sku: "NO-SUCH-SKU", quantity: 100 });
  assert.equal(result.status, 404);
  if (!result.body.ok) assert.equal(result.body.error.code, "PRICING_PROFILE_NOT_FOUND");
});

test("10. an inactive pricing profile returns 404", async () => {
  const result = await handlePricingApiRequest(prisma, INACTIVE_DOMAIN, { sku: inactiveProfileSku, quantity: 10 });
  assert.equal(result.status, 404);
  if (!result.body.ok) assert.equal(result.body.error.code, "PRICING_PROFILE_INACTIVE");
});

// --- 12. Tenant isolation -----------------------------------------------------------

test("12. the same SKU in two different stores returns each store's own pricing", async () => {
  const fromA = await handlePricingApiRequest(prisma, TENANT_A_DOMAIN, { sku: "SHARED", quantity: 10 });
  const fromB = await handlePricingApiRequest(prisma, TENANT_B_DOMAIN, { sku: "SHARED", quantity: 10 });
  assert.equal(fromA.status, 200);
  assert.equal(fromB.status, 200);
  if (fromA.body.ok && fromB.body.ok) {
    assert.equal(fromA.body.data.base.listUnitPriceCents, 1000);
    assert.equal(fromB.body.data.base.listUnitPriceCents, 2000);
  }
});

// --- 13. Malformed body reaching the handler ---------------------------------------

test("13. a non-object body (e.g. bare JSON string/number) returns 400, not a crash", async () => {
  const result = await handlePricingApiRequest(prisma, SHOP_DOMAIN, "just a string");
  assert.equal(result.status, 400);
  if (!result.body.ok) assert.equal(result.body.error.code, "INVALID_REQUEST_BODY");
});
