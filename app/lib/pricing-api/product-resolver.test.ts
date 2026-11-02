import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestPrisma } from "../../../test/support/prisma.ts";
import {
  parseShopifyNumericId,
  toProductGid,
  toVariantGid,
  numericIdFromGid,
  requireStorefrontProductContext,
  resolveStorefrontProductContext,
  type AdminGraphqlClientLike,
} from "./product-resolver.ts";
import { importPricingProfile } from "../pricing-import/import.ts";
import type { PricingProfileImportInput } from "../pricing-import/types.ts";

/**
 * Task 4A — the centralized storefront product/variant resolver. Store/override rows
 * are real (disposable, cleaned up in `after`, same style as tenant.test.ts); the
 * Admin GraphQL client is ALWAYS mocked — no test calls the live development store.
 */

const prisma = createTestPrisma();
const SUFFIX = `${process.pid}-${Date.now()}`;
const STORE_A = `resolver-test-a-${SUFFIX}.invalid`;
const STORE_B = `resolver-test-b-${SUFFIX}.invalid`;

// Bare decimal ids (Shopify shape) — deliberately large to prove no Number() conversion.
const PRODUCT_A = "9442404663548";
const VARIANT_A1 = "51028263796988";
const VARIANT_A2 = "51028263829756";
const PRODUCT_OTHER = "8000000000001";
const PRODUCT_CROSS = "8000000000999";

let storeAId = "";
let storeBId = "";
let profileAId = "";
let profileBId = "";

function minimalImport(shopDomain: string, sku: string, list: number): PricingProfileImportInput {
  return {
    shopDomain,
    sku,
    name: `Resolver test ${sku}`,
    quantityTiers: [{ minQuantity: 10, listPriceCents: list, netPriceCents: list - 50 }],
    decorationRules: [],
    optionGroups: [],
    productionRules: [{ code: "STANDARD", name: "Standard", minBusinessDays: 5 }],
    packagingRules: [{ code: "CARTON", name: "Carton" }],
  };
}

/** A mock Admin GraphQL client that always resolves the requested variant to the given
 * product id + availability. `productIdForVariant` defaults to PRODUCT_A. */
function mockAdmin(opts?: {
  productIdForVariant?: string | null;
  availableForSale?: boolean;
  variantIdOverride?: string | null;
  variantNull?: boolean;
  throws?: boolean;
  malformed?: boolean;
}): AdminGraphqlClientLike {
  return {
    graphql: async (_query, options) => {
      if (opts?.throws) throw new Error("network down");
      const requestedGid = String((options?.variables as { id?: unknown } | undefined)?.id ?? "");
      const requestedId = numericIdFromGid(requestedGid);
      if (opts?.malformed) return { json: async () => ({ nonsense: true }) };
      if (opts?.variantNull) return { json: async () => ({ data: { productVariant: null } }) };
      const variantId = opts?.variantIdOverride ?? requestedId;
      const productId = opts?.productIdForVariant === undefined ? PRODUCT_A : opts.productIdForVariant;
      return {
        json: async () => ({
          data: {
            productVariant: {
              id: variantId ? toVariantGid(variantId) : null,
              availableForSale: opts?.availableForSale ?? true,
              product: productId ? { id: toProductGid(productId) } : null,
            },
          },
        }),
      };
    },
  };
}

before(async () => {
  const a = await importPricingProfile(prisma, minimalImport(STORE_A, "SKU-A", 1000));
  storeAId = a.storeId;
  profileAId = a.pricingProfileId;
  const b = await importPricingProfile(prisma, minimalImport(STORE_B, "SKU-B", 2000));
  storeBId = b.storeId;
  profileBId = b.pricingProfileId;

  // Store A: an ACTIVE override for PRODUCT_A -> Store A's own active profile.
  await prisma.productPricingOverride.create({
    data: { storeId: storeAId, shopifyProductId: PRODUCT_A, pricingProfileId: profileAId, isActive: true },
  });
  // Store B has NO override for PRODUCT_A (proves scoping — item 9).
  // Store B: an override for PRODUCT_CROSS that points at STORE A's profile — a
  // cross-store profile reference that must be rejected, never resolved (item 10).
  await prisma.productPricingOverride.create({
    data: { storeId: storeBId, shopifyProductId: PRODUCT_CROSS, pricingProfileId: profileAId, isActive: true },
  });
  void profileBId;
});

after(async () => {
  await prisma.store.deleteMany({ where: { shopDomain: { in: [STORE_A, STORE_B] } } });
  await prisma.$disconnect();
});

// --- pure helpers ---------------------------------------------------------------

test("parseShopifyNumericId / GID helpers round-trip a large id with no numeric conversion", () => {
  assert.equal(parseShopifyNumericId(PRODUCT_A), PRODUCT_A);
  assert.equal(parseShopifyNumericId("gid://shopify/Product/1"), null);
  assert.equal(parseShopifyNumericId("0"), null);
  assert.equal(toProductGid(PRODUCT_A), `gid://shopify/Product/${PRODUCT_A}`);
  assert.equal(numericIdFromGid(toVariantGid(VARIANT_A1)), VARIANT_A1);
  assert.equal(numericIdFromGid("gid://shopify/Product/0"), null);
});

// --- Task 4A.1 §1: the public route requires BOTH ids (items 1-5) ---------------

test("4A.1: requireStorefrontProductContext accepts only when BOTH ids are valid decimal strings", () => {
  const ok = requireStorefrontProductContext(PRODUCT_A, VARIANT_A1);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.shopifyProductId, PRODUCT_A);
    assert.equal(ok.shopifyVariantId, VARIANT_A1);
  }
});

test("4A.1: both ids absent -> 400 INVALID_PRODUCT_CONTEXT (items 1, 2)", () => {
  const r = requireStorefrontProductContext(undefined, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_PRODUCT_CONTEXT");
  }
});

test("4A.1: only the product id present -> INVALID_PRODUCT_CONTEXT (item 3)", () => {
  const r = requireStorefrontProductContext(PRODUCT_A, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "INVALID_PRODUCT_CONTEXT");
});

test("4A.1: only the variant id present -> INVALID_PRODUCT_CONTEXT (item 4)", () => {
  const r = requireStorefrontProductContext(undefined, VARIANT_A1);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "INVALID_PRODUCT_CONTEXT");
});

test("4A.1: a blank or malformed id -> INVALID_PRODUCT_CONTEXT (never partially trusted)", () => {
  for (const [p, v] of [
    ["", VARIANT_A1],
    [PRODUCT_A, ""],
    ["   ", VARIANT_A1],
    ["gid://shopify/Product/1", VARIANT_A1],
    [PRODUCT_A, "0"],
    [PRODUCT_A, "12.5"],
    ["-1", VARIANT_A1],
  ] as Array<[unknown, unknown]>) {
    const r = requireStorefrontProductContext(p, v);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.body.error.code, "INVALID_PRODUCT_CONTEXT");
  }
});

test("4A.1 item 5: with no ids the Admin resolver is never even reached (gate returns before it)", async () => {
  // A resolver call that would otherwise fail closed at the Admin step — but the gate
  // stops the request first, so `admin` is irrelevant.
  const gate = requireStorefrontProductContext(undefined, undefined);
  assert.equal(gate.ok, false);
  // And the resolver itself, given a missing id, also fails closed (defense in depth).
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin(), shopDomain: STORE_A },
    { shopifyProductId: undefined, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "INVALID_PRODUCT_ID");
});

// --- Task 4A.1 §2: malformed SKU types (item 6) --------------------------------

test("4A.1 item 6: an explicit number / boolean / object / array SKU -> 400 INVALID_SKU (never coerced to '')", async () => {
  for (const badSku of [123, true, false, {}, [], { code: "x" }]) {
    const r = await resolveStorefrontProductContext(
      { prisma, admin: mockAdmin(), shopDomain: STORE_A },
      { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: badSku },
    );
    assert.equal(r.ok, false, `sku ${JSON.stringify(badSku)} must be rejected`);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, "INVALID_SKU");
    }
  }
});

test("4A.1 item 6: undefined / null SKU is normalized to '' (still resolves via the product override)", async () => {
  for (const sku of [undefined, null]) {
    const r = await resolveStorefrontProductContext(
      { prisma, admin: mockAdmin(), shopDomain: STORE_A },
      { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.resolutionSource, "product_override");
      assert.equal(r.sku, "");
    }
  }
});

// --- id validation (items 4, 5) ------------------------------------------------

test("4/5: an invalid product id fails closed (400 INVALID_PRODUCT_ID), even with a blank SKU", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin(), shopDomain: STORE_A },
    { shopifyProductId: "gid://shopify/Product/9442404663548", shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "INVALID_PRODUCT_ID");
  }
});

test("6: a malformed variant id fails closed (400 INVALID_VARIANT_ID)", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin(), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: "12.5", sku: "SKU-A" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "INVALID_VARIANT_ID");
});

// --- Admin verification (items 13, 14, 15, 16) --------------------------------

test("16: a missing Admin client fails closed (403 ADMIN_SESSION_UNAVAILABLE)", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: null, shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "ADMIN_SESSION_UNAVAILABLE");
  }
});

test("16: an Admin GraphQL request that throws fails closed (no leak)", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ throws: true }), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.body.error.code, "ADMIN_SESSION_UNAVAILABLE");
    assert.equal(JSON.stringify(r.body).includes("network down"), false);
  }
});

test("14: Admin returns a variant whose parent product differs -> PRODUCT_VARIANT_MISMATCH", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ productIdForVariant: PRODUCT_OTHER }), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, "PRODUCT_VARIANT_MISMATCH");
  }
});

test("14: Admin returns a variant whose own id differs from the requested id -> PRODUCT_VARIANT_MISMATCH", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ variantIdOverride: VARIANT_A2 }), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "PRODUCT_VARIANT_MISMATCH");
});

test("15: an unavailable variant fails closed (422 VARIANT_UNAVAILABLE)", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ availableForSale: false }), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "VARIANT_UNAVAILABLE");
});

test("13: Admin returns no variant -> VARIANT_NOT_FOUND; malformed body -> VARIANT_NOT_FOUND", async () => {
  const r1 = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ variantNull: true }), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.body.error.code, "VARIANT_NOT_FOUND");

  const r2 = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ malformed: true }), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.body.error.code, "VARIANT_NOT_FOUND");
});

// --- override resolution (items 7, 8, 9, 10, 11, 12) --------------------------

test("7: a valid product override resolves without a SKU (resolutionSource product_override, sku '')", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin(), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1 }, // no sku at all
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.resolutionSource, "product_override");
    assert.equal(r.sku, "");
    assert.equal(r.shopifyProductId, PRODUCT_A);
    assert.equal(r.shopifyVariantId, VARIANT_A1);
  }
});

test("8: the product override takes precedence over a conflicting SKU in the request", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin(), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "A-DELIBERATELY-WRONG-SKU" },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.resolutionSource, "product_override");
    assert.equal(r.sku, "");
  }
});

test("9: override lookup is scoped to the authenticated Store — Store A's PRODUCT_A override never applies to Store B", async () => {
  // Store B has no override row for PRODUCT_A. With a blank SKU it must fail closed
  // ("pricing not configured") — it must NOT borrow Store A's product_override.
  const blank = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin(), shopDomain: STORE_B },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.body.error.code, "PRICING_NOT_CONFIGURED");

  // With its own real SKU, Store B resolves by SKU — never `product_override`.
  const withSku = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin(), shopDomain: STORE_B },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "SKU-B" },
  );
  assert.equal(withSku.ok, true);
  if (withSku.ok) assert.equal(withSku.resolutionSource, "sku");
});

test("10: an override whose profile belongs to another Store cannot resolve (PRICING_CONFIGURATION_INVALID)", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ productIdForVariant: PRODUCT_CROSS }), shopDomain: STORE_B },
    { shopifyProductId: PRODUCT_CROSS, shopifyVariantId: VARIANT_A1, sku: "SKU-B" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, "PRICING_CONFIGURATION_INVALID");
  }
});

test("11: a blank SKU with no valid override fails closed (404 PRICING_NOT_CONFIGURED), never the default profile", async () => {
  // Store A, but a product id with NO override row -> blank SKU has nothing to resolve.
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ productIdForVariant: PRODUCT_OTHER }), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_OTHER, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "PRICING_NOT_CONFIGURED");
  }
});

test("12: an existing non-blank SKU still falls back and resolves when there is no override", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ productIdForVariant: PRODUCT_OTHER }), shopDomain: STORE_A },
    { shopifyProductId: PRODUCT_OTHER, shopifyVariantId: VARIANT_A1, sku: "SKU-A" },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.resolutionSource, "sku");
    assert.equal(r.sku, "SKU-A");
  }
});

test("an inactive override fails closed (PRICING_CONFIGURATION_INVALID), never a SKU fallback", async () => {
  const inactiveProduct = "8000000000777";
  await prisma.productPricingOverride.create({
    data: { storeId: storeAId, shopifyProductId: inactiveProduct, pricingProfileId: profileAId, isActive: false },
  });
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin({ productIdForVariant: inactiveProduct }), shopDomain: STORE_A },
    { shopifyProductId: inactiveProduct, shopifyVariantId: VARIANT_A1, sku: "SKU-A" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "PRICING_CONFIGURATION_INVALID");
});

test("an unknown shop fails closed (404 SHOP_NOT_AVAILABLE)", async () => {
  const r = await resolveStorefrontProductContext(
    { prisma, admin: mockAdmin(), shopDomain: `no-such-${SUFFIX}.invalid` },
    { shopifyProductId: PRODUCT_A, shopifyVariantId: VARIANT_A1, sku: "" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "SHOP_NOT_AVAILABLE");
});
