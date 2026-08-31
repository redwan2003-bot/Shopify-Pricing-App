import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  handleStorefrontPricingRequest,
  validateSigningSecret,
  validateAdjustmentVariantGid,
} from "./storefront-handler.ts";
import { importPricingProfile } from "../pricing-import/import.ts";
import type { PricingProfileImportInput } from "../pricing-import/types.ts";

/**
 * Sets the given environment variables for the duration of `fn`, then restores each
 * one to its exact prior state — `delete`d if it was originally `undefined`, never
 * reassigned the string `"undefined"`. Used by every cart-pricing test below so env
 * vars never leak between test cases regardless of run order.
 */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Covers the storefront pricing bridge's core logic against the real database — the
 * same coverage style as app/lib/pricing-api/handler.test.ts (Phase 2.4), since
 * `handleStorefrontPricingRequest` delegates to the exact same `handlePricingApiRequest`
 * for everything except trimming `source` from the success payload.
 *
 * The App Proxy signature-verification and session-resolution layer in front of this
 * (in app/routes/apps.imprintid-pricing.pricing.tsx) is *not* re-tested here — see
 * docs/storefront-pricing-bridge.md "Verification" for how that layer was verified
 * with a genuinely HMAC-signed request instead (it can't run under `node --test`
 * for the same module-resolution reason noted in Phase 2.4's report).
 */
const SHOP_DOMAIN = "imprintid-pricing-development.myshopify.com";
const SKU = "LNY01";

const prisma = new PrismaClient();

const SUFFIX = `${process.pid}-${Date.now()}`;
const TENANT_A_DOMAIN = `storefront-bridge-test-a-${SUFFIX}.invalid`;
const TENANT_B_DOMAIN = `storefront-bridge-test-b-${SUFFIX}.invalid`;

function minimalImport(
  shopDomain: string,
  sku: string,
  extra: Partial<PricingProfileImportInput> = {},
): PricingProfileImportInput {
  return {
    shopDomain,
    sku,
    name: `Storefront bridge test product ${sku}`,
    quantityTiers: [{ minQuantity: 10, listPriceCents: 500, netPriceCents: 400 }],
    decorationRules: [],
    optionGroups: [],
    productionRules: [{ code: "STANDARD", name: "Standard", minBusinessDays: 5 }],
    packagingRules: [{ code: "CARTON", name: "Carton" }],
    ...extra,
  };
}

before(async () => {
  await importPricingProfile(
    prisma,
    minimalImport(TENANT_A_DOMAIN, "SHARED", {
      quantityTiers: [{ minQuantity: 10, listPriceCents: 1000, netPriceCents: 900 }],
    }),
  );
  await importPricingProfile(
    prisma,
    minimalImport(TENANT_B_DOMAIN, "SHARED", {
      quantityTiers: [{ minQuantity: 10, listPriceCents: 2000, netPriceCents: 1900 }],
    }),
  );
});

after(async () => {
  await prisma.store.deleteMany({ where: { shopDomain: { in: [TENANT_A_DOMAIN, TENANT_B_DOMAIN] } } });
  await prisma.$disconnect();
});

// --- 1. Valid storefront pricing request, against real seeded LNY01 ---------------

test("1. a valid storefront request returns 200 with the real database's pricing", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100 });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.equal(result.body.data.base.listUnitPriceCents, 229);
    assert.equal(result.body.data.base.netUnitPriceCents, 137);
    assert.equal(result.body.data.totals.listTotalCents, 22900);
  }
});

test("the storefront response never includes `source` (storeId/pricingProfileId/resolvedVia)", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100 });
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.equal("source" in result.body.data, false);
    // Everything else a storefront UI needs is still present.
    assert.ok(result.body.data.quantityTier);
    assert.ok(result.body.data.base);
    assert.ok(result.body.data.production);
  }
});

test("the storefront response includes availableQuantityTiers for a quantity-break table", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100 });
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.deepEqual(
      result.body.data.availableQuantityTiers.map((t) => t.minQuantity),
      [100, 300, 500, 1000, 3000, 5000],
    );
  }
});

// --- 2-3. Boundary/shape errors -----------------------------------------------------

test("2. missing SKU returns 400", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { quantity: 100 });
  assert.equal(result.status, 400);
  if (!result.body.ok) assert.equal(result.body.error.code, "INVALID_REQUEST_BODY");
});

test("3. an invalid quantity (wrong type) returns 400", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: "lots" });
  assert.equal(result.status, 400);
});

test("3b. an invalid quantity (below minimum tier) returns 422", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 5 });
  assert.equal(result.status, 422);
  if (!result.body.ok) assert.equal(result.body.error.code, "QUANTITY_BELOW_MINIMUM");
});

// --- 4-6. Domain/engine errors, 422 -------------------------------------------------

test("4. an invalid decoration selection returns 422", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
    sku: SKU,
    quantity: 100,
    decoration: {
      method: "SCREEN_PRINT",
      colors: 0,
      locations: 1,
      reverseSide: false,
      differentReverseArtwork: false,
      repeatOrder: false,
    },
  });
  assert.equal(result.status, 422);
  if (!result.body.ok) assert.equal(result.body.error.code, "INVALID_DECORATION_SELECTION");
});

test("5. an invalid option value returns 422", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
    sku: SKU,
    quantity: 100,
    options: [{ groupName: "Optional Features", optionValueId: "not-a-real-id" }],
  });
  assert.equal(result.status, 422);
  if (!result.body.ok) assert.equal(result.body.error.code, "INVALID_OPTION_VALUE");
});

test("6. an invalid production selection returns 422", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
    sku: SKU,
    quantity: 100,
    production: { code: "SAME_DAY_TELEPORT" },
  });
  assert.equal(result.status, 422);
  if (!result.body.ok) assert.equal(result.body.error.code, "PRODUCTION_RULE_NOT_FOUND");
});

// --- 7. Not found --------------------------------------------------------------------

test("7. an unknown pricing profile (SKU) returns 404", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: "NO-SUCH-SKU", quantity: 100 });
  assert.equal(result.status, 404);
  if (!result.body.ok) assert.equal(result.body.error.code, "PRICING_PROFILE_NOT_FOUND");
});

// --- 8. Tenant isolation --------------------------------------------------------------

test("8. the same SKU in two different stores returns each store's own pricing", async () => {
  const fromA = await handleStorefrontPricingRequest(prisma, TENANT_A_DOMAIN, { sku: "SHARED", quantity: 10 });
  const fromB = await handleStorefrontPricingRequest(prisma, TENANT_B_DOMAIN, { sku: "SHARED", quantity: 10 });
  assert.equal(fromA.status, 200);
  assert.equal(fromB.status, 200);
  if (fromA.body.ok && fromB.body.ok) {
    assert.equal(fromA.body.data.base.listUnitPriceCents, 1000);
    assert.equal(fromB.body.data.base.listUnitPriceCents, 2000);
  }
});

// --- 9. Malformed request --------------------------------------------------------------

test("9. a malformed (non-object) request body returns 400, not a crash", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, "not an object");
  assert.equal(result.status, 400);
});

// --- validateSigningSecret / validateAdjustmentVariantGid — direct, isolated unit tests ---

test("validateSigningSecret: a well-formed secret is accepted, unmodified", () => {
  assert.equal(validateSigningSecret("a-real-secret-value"), "a-real-secret-value");
});

test("validateSigningSecret: undefined is rejected", () => {
  assert.equal(validateSigningSecret(undefined), null);
});

test("validateSigningSecret: an empty string is rejected", () => {
  assert.equal(validateSigningSecret(""), null);
});

test("validateSigningSecret: a whitespace-only string is rejected", () => {
  assert.equal(validateSigningSecret("   "), null);
});

test("validateSigningSecret: leading/trailing whitespace is rejected, never trimmed", () => {
  assert.equal(validateSigningSecret(" valid-secret "), null);
  assert.equal(validateSigningSecret("valid-secret\n"), null);
  assert.equal(validateSigningSecret("\tvalid-secret"), null);
});

test("validateAdjustmentVariantGid: a well-formed GID is accepted", () => {
  assert.equal(validateAdjustmentVariantGid("gid://shopify/ProductVariant/123"), "gid://shopify/ProductVariant/123");
});

test("validateAdjustmentVariantGid: an all-zero numeric id is rejected", () => {
  assert.equal(validateAdjustmentVariantGid("gid://shopify/ProductVariant/000000000000"), null);
});

test("validateAdjustmentVariantGid: id \"0\" is rejected", () => {
  assert.equal(validateAdjustmentVariantGid("gid://shopify/ProductVariant/0"), null);
});

test("validateAdjustmentVariantGid: a bare numeric id (no GID prefix) is rejected, never converted into a GID", () => {
  assert.equal(validateAdjustmentVariantGid("51028460460"), null);
});

test("validateAdjustmentVariantGid: the wrong Shopify resource type is rejected", () => {
  assert.equal(validateAdjustmentVariantGid("gid://shopify/Product/123"), null);
});

test("validateAdjustmentVariantGid: a GID with no id at all is rejected", () => {
  assert.equal(validateAdjustmentVariantGid("gid://shopify/ProductVariant/"), null);
});

test("validateAdjustmentVariantGid: placeholder text is rejected", () => {
  assert.equal(validateAdjustmentVariantGid("REPLACE_WITH_VARIANT_ID"), null);
});

test("validateAdjustmentVariantGid: blank and whitespace-only values are rejected", () => {
  assert.equal(validateAdjustmentVariantGid(""), null);
  assert.equal(validateAdjustmentVariantGid("   "), null);
});

test("validateAdjustmentVariantGid: undefined and non-string values are rejected", () => {
  assert.equal(validateAdjustmentVariantGid(undefined), null);
  assert.equal(validateAdjustmentVariantGid(12345), null);
  assert.equal(validateAdjustmentVariantGid(null), null);
});

// --- 11. Cart pricing payload (imprintid-cart-pricing integration) -----------------

test("11. no shopifyVariantId in the request -> cartPricing is null (existing callers unaffected)", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100 });
  assert.equal(result.body.ok, true);
  if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
});

test("12. shopifyVariantId given but IMPRINTID_CART_SIGNING_SECRET/IMPRINTID_ADJUSTMENT_VARIANT_ID unset -> cartPricing is null, not an error", async () => {
  await withEnv({ IMPRINTID_CART_SIGNING_SECRET: undefined, IMPRINTID_ADJUSTMENT_VARIANT_ID: undefined }, async () => {
    const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
      sku: SKU,
      quantity: 100,
      shopifyVariantId: "gid://shopify/ProductVariant/1",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
  });
});

test("12b. SHOPIFY_API_SECRET set alone (no IMPRINTID_CART_SIGNING_SECRET) -> cartPricing is null — no fallback between the two secrets", async () => {
  await withEnv(
    {
      SHOPIFY_API_SECRET: "an-oauth-secret-that-must-never-sign-cart-pricing",
      IMPRINTID_CART_SIGNING_SECRET: undefined,
      IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999",
    },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
        sku: SKU,
        quantity: 100,
        shopifyVariantId: "gid://shopify/ProductVariant/1",
      });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

test("12c. a blank IMPRINTID_CART_SIGNING_SECRET fails closed", async () => {
  await withEnv(
    { IMPRINTID_CART_SIGNING_SECRET: "   ", IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999" },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
        sku: SKU,
        quantity: 100,
        shopifyVariantId: "gid://shopify/ProductVariant/1",
      });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

test("12d. an IMPRINTID_CART_SIGNING_SECRET with leading/trailing whitespace fails closed, end to end", async () => {
  await withEnv(
    { IMPRINTID_CART_SIGNING_SECRET: " valid-secret ", IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999" },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
        sku: SKU,
        quantity: 100,
        shopifyVariantId: "gid://shopify/ProductVariant/1",
      });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

test("12e. a valid secret with an invalid adjustment-variant id (bare numeric) fails closed", async () => {
  await withEnv(
    { IMPRINTID_CART_SIGNING_SECRET: "test-secret-for-storefront-handler", IMPRINTID_ADJUSTMENT_VARIANT_ID: "51028460460" },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
        sku: SKU,
        quantity: 100,
        shopifyVariantId: "gid://shopify/ProductVariant/1",
      });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

test("13. shopifyVariantId given and secret/adjustment variant configured -> a genuinely signed cartPricing payload is returned", async () => {
  await withEnv(
    {
      IMPRINTID_CART_SIGNING_SECRET: "test-secret-for-storefront-handler",
      IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999",
    },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, {
        sku: SKU,
        quantity: 100,
        shopifyVariantId: "gid://shopify/ProductVariant/1",
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      if (result.body.ok) {
        const cartPricing = result.body.data.cartPricing;
        assert.ok(cartPricing);
        assert.equal(cartPricing!.version, 1);
        const parsed = JSON.parse(cartPricing!.payload);
        assert.equal(parsed.sku, SKU);
        assert.equal(parsed.quantity, 100);
        assert.equal(parsed.baseVariantId, "gid://shopify/ProductVariant/1");
        assert.equal(parsed.adjustmentVariantId, "gid://shopify/ProductVariant/999");
        assert.equal(parsed.baseUnitPriceCents, result.body.data.base.netUnitPriceCents);
        // The signature genuinely verifies against the same secret used to sign it —
        // proving compatibility with the Function's own verification logic, which
        // uses the identical canonicalization + signHex primitives.
        const { canonicalizeCartPricingPayload } = await import("./cart-signature.ts");
        const { signHex } = await import("./hmac-sha256.ts");
        assert.equal(
          cartPricing!.signature,
          signHex("test-secret-for-storefront-handler", canonicalizeCartPricingPayload(parsed)),
        );
      }
    },
  );
});

test("14. an empty-string shopifyVariantId is treated the same as omitted -> cartPricing is null", async () => {
  await withEnv(
    { IMPRINTID_CART_SIGNING_SECRET: "test-secret", IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999" },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100, shopifyVariantId: "" });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

// --- 10. Internal error sanitization ---------------------------------------------------

test("10. an unexpected internal error is never leaked to the storefront response", async () => {
  // handleStorefrontPricingRequest reuses handlePricingApiRequest's own error mapping
  // (see response.test.ts for the direct proof it never forwards a raw message) — this
  // asserts the same guarantee holds through the storefront-specific wrapper too, using
  // a shopDomain that produces a real StoreNotFound rather than a fabricated failure.
  const result = await handleStorefrontPricingRequest(prisma, "no-such-shop.invalid", { sku: SKU, quantity: 100 });
  assert.equal(result.status, 404);
  if (!result.body.ok) {
    assert.equal(JSON.stringify(result.body).includes("Prisma"), false);
    assert.equal("stack" in result.body.error, false);
  }
});
