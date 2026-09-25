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
/**
 * Task 5B.1.1: the storefront only issues a v1 quote under an explicit non-production
 * transition authorization. Tests that exercise the v1 SIGNING guards (missing/blank
 * secret, bad adjustment variant, …) must set this so the v1 path is actually reached
 * and it is the guard — not "no envelope selected" — that produces `cartPricing: null`.
 */
const V1_TRANSITION_ENV = {
  NODE_ENV: "test",
  IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: "true",
  IMPRINTID_CART_ENVELOPE_VERSION: "1",
} as const;

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
const LNY01_PRODUCT_ID = "9442404663548"; // the codebase-wide convention for "the LNY01 product" (see product-resolver.test.ts)

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

  // The product-override tests below (Task 4A, "product_override" resolutionSource) need an
  // active ProductPricingOverride linking LNY01_PRODUCT_ID to the real seeded LNY01 profile
  // (prisma/seed.ts) — deliberately NOT part of that seed itself, since the product<->profile
  // link is store-specific runtime state, not portable pricing data. Mirrors the same
  // self-contained fixture pattern product-resolver.test.ts already uses for this exact id.
  const lny01Store = await prisma.store.findUnique({ where: { shopDomain: SHOP_DOMAIN } });
  const lny01Profile = lny01Store ? await prisma.pricingProfile.findFirst({ where: { storeId: lny01Store.id, sku: SKU } }) : null;
  if (lny01Store && lny01Profile) {
    await prisma.productPricingOverride.upsert({
      where: { storeId_shopifyProductId: { storeId: lny01Store.id, shopifyProductId: LNY01_PRODUCT_ID } },
      update: { pricingProfileId: lny01Profile.id, isActive: true },
      create: { storeId: lny01Store.id, shopifyProductId: LNY01_PRODUCT_ID, pricingProfileId: lny01Profile.id, isActive: true },
    });
  }
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
  await withEnv({ ...V1_TRANSITION_ENV, IMPRINTID_CART_SIGNING_SECRET: undefined, IMPRINTID_ADJUSTMENT_VARIANT_ID: undefined }, async () => {
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
      ...V1_TRANSITION_ENV,
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
    { ...V1_TRANSITION_ENV, IMPRINTID_CART_SIGNING_SECRET: "   ", IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999" },
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
    { ...V1_TRANSITION_ENV, IMPRINTID_CART_SIGNING_SECRET: " valid-secret ", IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999" },
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
    { ...V1_TRANSITION_ENV, IMPRINTID_CART_SIGNING_SECRET: "test-secret-for-storefront-handler", IMPRINTID_ADJUSTMENT_VARIANT_ID: "51028460460" },
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

test("13. shopifyVariantId given + secret/adjustment variant configured + a CONTROLLED non-production v1 transition -> a genuinely signed v1 cartPricing payload is returned", async () => {
  await withEnv(
    {
      IMPRINTID_CART_SIGNING_SECRET: "test-secret-for-storefront-handler",
      IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999",
      // Task 5B.1.1: v1 is issued ONLY under this explicit non-production authorization.
      NODE_ENV: "test",
      IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: "true",
      IMPRINTID_CART_ENVELOPE_VERSION: "1",
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
    { ...V1_TRANSITION_ENV, IMPRINTID_CART_SIGNING_SECRET: "test-secret", IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999" },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100, shopifyVariantId: "" });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

// --- Task 5B.1.1: envelope selection (no silent v1 default) --------------------------

test("5B.1.1 selectCartEnvelope: absent version -> 'none'; unsupported -> 'none'; '2' -> 'v2'", async () => {
  const { selectCartEnvelope } = await import("./storefront-handler.ts");
  await withEnv({ IMPRINTID_CART_ENVELOPE_VERSION: undefined, IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: undefined, NODE_ENV: "test" }, async () => {
    assert.equal(selectCartEnvelope(), "none");
  });
  await withEnv({ IMPRINTID_CART_ENVELOPE_VERSION: "3", NODE_ENV: "test" }, async () => {
    assert.equal(selectCartEnvelope(), "none");
  });
  await withEnv({ IMPRINTID_CART_ENVELOPE_VERSION: "2", NODE_ENV: "test" }, async () => {
    assert.equal(selectCartEnvelope(), "v2");
  });
});

test("5B.1.1 selectCartEnvelope: '1' needs ALL of: not production, ALLOW flag 'true', version exactly '1'", async () => {
  const { selectCartEnvelope } = await import("./storefront-handler.ts");
  // version '1' but no ALLOW flag -> none
  await withEnv({ IMPRINTID_CART_ENVELOPE_VERSION: "1", IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: undefined, NODE_ENV: "test" }, async () => {
    assert.equal(selectCartEnvelope(), "none");
  });
  // version '1' + ALLOW but PRODUCTION -> none (production never issues v1)
  await withEnv({ IMPRINTID_CART_ENVELOPE_VERSION: "1", IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: "true", NODE_ENV: "production" }, async () => {
    assert.equal(selectCartEnvelope(), "none");
  });
  // version '1' + ALLOW 'yes' (not exactly 'true') -> none
  await withEnv({ IMPRINTID_CART_ENVELOPE_VERSION: "1", IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: "yes", NODE_ENV: "test" }, async () => {
    assert.equal(selectCartEnvelope(), "none");
  });
  // all three satisfied -> v1
  await withEnv({ IMPRINTID_CART_ENVELOPE_VERSION: "1", IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: "true", NODE_ENV: "test" }, async () => {
    assert.equal(selectCartEnvelope(), "v1");
  });
});

test("5B.1.1: a request with a variant id + valid secret but NO envelope version -> cartPricing is null (no silent v1)", async () => {
  await withEnv(
    {
      IMPRINTID_CART_SIGNING_SECRET: "test-secret-for-storefront-handler",
      IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999",
      IMPRINTID_CART_ENVELOPE_VERSION: undefined,
      IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: undefined,
      NODE_ENV: "test",
    },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100, shopifyVariantId: "gid://shopify/ProductVariant/1" });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

test("5B.1.1: an UNSUPPORTED envelope version fails closed -> cartPricing is null", async () => {
  await withEnv(
    {
      IMPRINTID_CART_SIGNING_SECRET: "test-secret-for-storefront-handler",
      IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999",
      IMPRINTID_CART_ENVELOPE_VERSION: "v2",
      NODE_ENV: "test",
    },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100, shopifyVariantId: "gid://shopify/ProductVariant/1" });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

test("5B.1.1: production runtime never issues a v1 quote even with the ALLOW flag + version '1'", async () => {
  await withEnv(
    {
      IMPRINTID_CART_SIGNING_SECRET: "test-secret-for-storefront-handler",
      IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999",
      IMPRINTID_CART_ENVELOPE_VERSION: "1",
      IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: "true",
      NODE_ENV: "production",
    },
    async () => {
      const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100, shopifyVariantId: "gid://shopify/ProductVariant/1" });
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

test("5B.1.1: envelope '2' attempts v2 but fails closed (null policy provider) -> cartPricing is null, never downgraded to v1", async () => {
  await withEnv(
    {
      IMPRINTID_CART_SIGNING_SECRET: "test-secret-for-storefront-handler",
      IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/999",
      IMPRINTID_CART_ENVELOPE_VERSION: "2",
      NODE_ENV: "test",
    },
    async () => {
      const result = await handleStorefrontPricingRequest(
        prisma,
        SHOP_DOMAIN,
        { sku: SKU, quantity: 100, shopifyVariantId: "gid://shopify/ProductVariant/1", shopifyProductId: "9442404663548" },
        { shopifyProductId: "9442404663548", shopifyVariantId: "1" },
      );
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

// --- Task 4A: identity echo + blank-SKU-via-product-override --------------------------

test("4A. a request identity is echoed back with the resolution source", async () => {
  const result = await handleStorefrontPricingRequest(
    prisma,
    SHOP_DOMAIN,
    { sku: SKU, quantity: 100 },
    { shopifyProductId: LNY01_PRODUCT_ID, shopifyVariantId: "51028263796988" },
  );
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.deepEqual(result.body.data.identity, {
      shopifyProductId: LNY01_PRODUCT_ID,
      shopifyVariantId: "51028263796988",
      resolutionSource: "sku",
    });
  }
});

test("4A. a BLANK sku plus the LNY01 product id prices via the active ProductPricingOverride (resolutionSource product_override)", async () => {
  const result = await handleStorefrontPricingRequest(
    prisma,
    SHOP_DOMAIN,
    { sku: "", quantity: 100, shopifyProductId: LNY01_PRODUCT_ID },
    { shopifyProductId: LNY01_PRODUCT_ID, shopifyVariantId: "51028263796988" },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  if (result.body.ok) {
    assert.equal(result.body.data.base.listUnitPriceCents, 229, "same real LNY01 pricing as the SKU path");
    assert.equal(result.body.data.identity!.resolutionSource, "product_override");
  }
});

test("4A. a blank sku with NO shopifyProductId is still rejected (400)", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: "", quantity: 100 });
  assert.equal(result.status, 400);
  if (!result.body.ok) assert.equal(result.body.error.code, "INVALID_REQUEST_BODY");
});

test("4A. no request identity -> identity is null (legacy callers unaffected)", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100 });
  assert.equal(result.body.ok, true);
  if (result.body.ok) assert.equal(result.body.data.identity, null);
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

// --- Task 5B.3A: authoritative v2 quote issuance ------------------------------------

const V2_SECRET = "storefront-handler-v2-signing-secret";
const V2_ADJ = "gid://shopify/ProductVariant/424242";
const LNY01_VARIANT_ID = "51028263796988";

/** A policy provider that returns a fixed `enforce` decision — stands in for the real
 * `createDefaultCartPricingPolicyProvider` reading the app-owned metafields, which do
 * not exist on the dev store yet. */
const fixedProvider = (over: Partial<Record<string, unknown>> = {}) => ({
  async resolve() {
    return {
      action: "enforce",
      context: {
        installBinding: "install-binding-5b3a",
        adjustmentVariantGid: V2_ADJ,
        policyRevision: 9,
        profileRef: "prof_LNY01",
        profileRevision: 21,
        // Task 5B.3B.2 — the real LNY01 dev pricing profile is priced in USD; a quote is
        // signed only when this equals it. Individual tests override to prove the gate.
        shopCurrency: "USD",
        ...over,
      },
    };
  },
});
/** A `block` decision — a mandatory fail-closed condition. */
const blockingProvider = { async resolve() { return { action: "block", reason: "shop_policy_missing" }; } };
/** A `bypass` decision — enforcement explicitly, safely OFF. */
const bypassProvider = { async resolve() { return { action: "bypass", reason: "shop_disabled" }; } };

const V2_ENV = {
  IMPRINTID_CART_ENVELOPE_VERSION: "2",
  IMPRINTID_CART_SIGNING_SECRET: V2_SECRET,
  IMPRINTID_ADJUSTMENT_VARIANT_ID: V2_ADJ,
  NODE_ENV: "test",
} as const;

async function v2Result(body: Record<string, unknown>, provider: { resolve: () => Promise<unknown> }) {
  return handleStorefrontPricingRequest(
    prisma,
    SHOP_DOMAIN,
    { sku: "", shopifyProductId: LNY01_PRODUCT_ID, ...body },
    { shopifyProductId: LNY01_PRODUCT_ID, shopifyVariantId: LNY01_VARIANT_ID },
    { policyProvider: provider as never },
  );
}

test("5B.3A: a valid authoritative calculation returns a COMPLETE v2 quote (all bound fields, verifying signature)", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider());
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    const cp = result.body.data.cartPricing;
    assert.ok(cp, "a v2 quote was issued");
    assert.equal(cp!.version, 2);
    assert.ok("config" in cp!, "carries the normalized config attribute");

    const p = JSON.parse(cp!.payload) as Record<string, unknown>;
    // install / product / variant / quantity / currency / adjustment / revisions / digest
    assert.equal(p.v, 2);
    assert.equal(p.installBinding, "install-binding-5b3a");
    assert.equal(p.productGid, `gid://shopify/Product/${LNY01_PRODUCT_ID}`);
    assert.equal(p.variantGid, `gid://shopify/ProductVariant/${LNY01_VARIANT_ID}`);
    assert.equal(p.quantity, 100);
    assert.equal(p.currency, "USD");
    assert.equal(p.adjustmentVariantGid, V2_ADJ);
    assert.equal(p.policyRevision, 9);
    assert.equal(p.profileRef, "prof_LNY01");
    assert.equal(p.profileRevision, 21);
    assert.equal(typeof p.configDigest, "string");
    assert.ok(String(p.configDigest).startsWith("sha256:"));
    assert.equal(typeof p.quoteId, "string");
    assert.equal(typeof p.issuedAtServer, "number");
    // base / component / total cents come from the engine result, not the request
    assert.equal(p.baseUnitPriceCents, result.body.data.base.netUnitPriceCents);
    assert.equal(
      (p.baseUnitPriceCents as number) * 100 + (p.perUnitSurchargeCents as number) * 100 + (p.flatSurchargeCents as number),
      p.lineTotalCents,
    );

    // signature verifies with the same primitives the Function uses
    const { canonicalizeCartPricingPayloadV2 } = await import("./cart-pricing-contract.ts");
    const { signHex } = await import("./hmac-sha256.ts");
    assert.equal(cp!.signature, signHex(V2_SECRET, canonicalizeCartPricingPayloadV2(p as never)));

    // config attribute re-hashes to the signed digest
    const { digestOfConfigJson } = await import("./config-normalization.ts");
    const d = digestOfConfigJson(cp!.config);
    assert.ok(d.ok && d.digest === p.configDigest);
  });
});

test("5B.3A: browser-supplied monetary totals + adjustment variant in the body are IGNORED", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result(
      {
        quantity: 100,
        // hostile extras — none of these may reach the payload
        lineTotalCents: 1,
        baseUnitPriceCents: 1,
        totals: { netTotalCents: 1 },
        adjustmentVariantGid: "gid://shopify/ProductVariant/1",
        installBinding: "attacker",
        profileRevision: 999,
        policyRevision: 999,
        configDigest: "sha256:deadbeef",
      },
      fixedProvider(),
    );
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    const p = JSON.parse(result.body.data.cartPricing!.payload) as Record<string, unknown>;
    assert.equal(p.adjustmentVariantGid, V2_ADJ, "adjustment variant is the server's, not the body's");
    assert.equal(p.installBinding, "install-binding-5b3a");
    assert.equal(p.profileRevision, 21);
    assert.equal(p.policyRevision, 9);
    assert.notEqual(p.lineTotalCents, 1);
    assert.notEqual(p.baseUnitPriceCents, 1);
    assert.notEqual(p.configDigest, "sha256:deadbeef");
  });
});

test("5B.3A: env adjustment GID that disagrees with the shop policy → fail closed (no v2 quote)", async () => {
  await withEnv({ ...V2_ENV, IMPRINTID_ADJUSTMENT_VARIANT_ID: "gid://shopify/ProductVariant/111" }, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider({ adjustmentVariantGid: V2_ADJ }));
    assert.equal(result.body.ok, true);
    if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
  });
});

test("5B.3A: env adjustment pin set to something that is not a variant GID → fail closed", async () => {
  for (const bad of ["424242", "gid://shopify/Product/1", "  "]) {
    await withEnv({ ...V2_ENV, IMPRINTID_ADJUSTMENT_VARIANT_ID: bad }, async () => {
      const result = await v2Result({ quantity: 100 }, fixedProvider());
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null, String(bad));
    });
  }
});

test("multi-shop: with no env pin, the quote uses the shop policy's own adjustment variant", async () => {
  const shopAdj = "gid://shopify/ProductVariant/777001";
  await withEnv({ ...V2_ENV, IMPRINTID_ADJUSTMENT_VARIANT_ID: undefined }, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider({ adjustmentVariantGid: shopAdj }));
    assert.equal(result.body.ok, true);
    if (result.body.ok) {
      assert.ok(result.body.data.cartPricing, "a signed quote is issued");
      const payload = JSON.parse(result.body.data.cartPricing!.payload);
      assert.equal(payload.adjustmentVariantGid, shopAdj);
    }
  });
});

test("multi-shop: with no env pin, a shop policy without a valid adjustment variant fails closed", async () => {
  await withEnv({ ...V2_ENV, IMPRINTID_ADJUSTMENT_VARIANT_ID: undefined }, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider({ adjustmentVariantGid: "gid://shopify/Product/5" }));
    assert.equal(result.body.ok, true);
    if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
  });
});

test("5B.3A: signing secret missing / blank / whitespace-only / padded → calc still returned for display, cartPricing null", async () => {
  for (const bad of [undefined, "", "   ", " has-leading-space", "trailing-space "]) {
    await withEnv({ ...V2_ENV, IMPRINTID_CART_SIGNING_SECRET: bad }, async () => {
      const result = await v2Result({ quantity: 100 }, fixedProvider());
      assert.equal(result.body.ok, true);
      if (result.body.ok) {
        assert.equal(result.body.data.base.netUnitPriceCents, 137, "display pricing still present");
        assert.equal(result.body.data.cartPricing, null, `secret=${JSON.stringify(bad)}`);
      }
    });
  }
});

test("5B.3A: SHOPIFY_API_SECRET set alone is NOT used to sign a v2 quote (no OAuth-secret fallback)", async () => {
  await withEnv(
    { ...V2_ENV, IMPRINTID_CART_SIGNING_SECRET: undefined, SHOPIFY_API_SECRET: "the-oauth-app-secret" },
    async () => {
      const result = await v2Result({ quantity: 100 }, fixedProvider());
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
    },
  );
});

test("5B.3A: a `block` decision → no signed quote, never v1", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, blockingProvider);
    assert.equal(result.body.ok, true);
    if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
  });
});

test("5B.3A: env '2' NEVER downgrades to v1 even in the non-production transition window", async () => {
  await withEnv(
    { ...V2_ENV, IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1: "true" },
    async () => {
      const result = await v2Result({ quantity: 100 }, blockingProvider);
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null, "no v1 fallback");
    },
  );
});

// --- Task 5B.3A.1: the three-state enforcement decision on the response ---------------

test("5B.3A.1: an `enforce` decision + a signed quote → enforcement.state 'enforce'", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider());
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    assert.ok(result.body.data.cartPricing);
    assert.deepEqual(result.body.data.enforcement, { state: "enforce" });
  });
});

test("5B.3A.1: a `bypass` decision → NO signed quote, enforcement.state 'bypass' (release native containment)", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, bypassProvider);
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    assert.equal(result.body.data.cartPricing, null, "no signed quote when enforcement is bypassed");
    assert.deepEqual(result.body.data.enforcement, { state: "bypass" });
    assert.equal(result.body.data.base.netUnitPriceCents, 137, "display pricing still computed");
  });
});

test("5B.3A.1: a `block` decision → enforcement.state 'block'", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, blockingProvider);
    assert.equal(result.body.ok, true);
    if (result.body.ok) assert.deepEqual(result.body.data.enforcement, { state: "block" });
  });
});

test("5B.3A.1: an `enforce` decision on a deployment that CANNOT sign → downgraded to enforcement.state 'block'", async () => {
  await withEnv({ ...V2_ENV, IMPRINTID_CART_SIGNING_SECRET: undefined }, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider());
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    assert.equal(result.body.data.cartPricing, null);
    assert.deepEqual(result.body.data.enforcement, { state: "block" }, "an enforced product that can't be signed stays contained");
  });
});

test("5B.3A.1: a `bypass` decision reports 'bypass' even when the deployment could not issue a v2 quote", async () => {
  await withEnv({ ...V2_ENV, IMPRINTID_CART_SIGNING_SECRET: undefined }, async () => {
    const result = await v2Result({ quantity: 100 }, bypassProvider);
    assert.equal(result.body.ok, true);
    if (result.body.ok) assert.deepEqual(result.body.data.enforcement, { state: "bypass" });
  });
});

test("5B.3A.1: enforcement is 'block' by default — a legacy request with no identity", async () => {
  const result = await handleStorefrontPricingRequest(prisma, SHOP_DOMAIN, { sku: SKU, quantity: 100 });
  assert.equal(result.body.ok, true);
  if (result.body.ok) assert.deepEqual(result.body.data.enforcement, { state: "block" });
});

test("5B.3A.1: the reason behind a bypass/block is NEVER exposed in the response", async () => {
  await withEnv(V2_ENV, async () => {
    for (const provider of [bypassProvider, blockingProvider]) {
      const result = await v2Result({ quantity: 100 }, provider);
      assert.equal(result.body.ok, true);
      if (!result.body.ok) continue;
      const serialized = JSON.stringify(result.body.data.enforcement);
      assert.equal(/reason|shop_disabled|shop_policy_missing|maintenance/.test(serialized), false, serialized);
      assert.deepEqual(Object.keys(result.body.data.enforcement), ["state"]);
    }
  });
});

test("5B.3A: the v2 response never contains the signing secret or an unsigned canonical message", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider());
    assert.equal(result.body.ok, true);
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes(V2_SECRET), false, "secret never in the response");
    // the canonical (newline-joined key=value) string is never returned — only the JSON payload + hex signature
    assert.equal(serialized.includes("installBinding=install-binding-5b3a\n"), false);
  });
});

test("5B.3A: blank Shopify SKU + LNY01 product id prices via the active ProductPricingOverride and still issues a complete v2 quote", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100, sku: "" }, fixedProvider());
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    assert.equal(result.body.data.identity!.resolutionSource, "product_override");
    const cp = result.body.data.cartPricing;
    assert.ok(cp, "v2 quote issued for a blank-SKU / product-override variant");
    const p = JSON.parse(cp!.payload) as Record<string, unknown>;
    assert.equal(p.variantGid, `gid://shopify/ProductVariant/${LNY01_VARIANT_ID}`);
    assert.equal(p.productGid, `gid://shopify/Product/${LNY01_PRODUCT_ID}`);
  });
});

test("5B.3A: the default provider (no admin) fails closed — v2 attempted, cartPricing null, never v1", async () => {
  await withEnv(V2_ENV, async () => {
    // no `policyProvider` and no `admin` in options ⇒ createDefaultCartPricingPolicyProvider({ admin: null })
    const result = await handleStorefrontPricingRequest(
      prisma,
      SHOP_DOMAIN,
      { sku: "", quantity: 100, shopifyProductId: LNY01_PRODUCT_ID },
      { shopifyProductId: LNY01_PRODUCT_ID, shopifyVariantId: LNY01_VARIANT_ID },
    );
    assert.equal(result.body.ok, true);
    if (result.body.ok) assert.equal(result.body.data.cartPricing, null);
  });
});

// --- Task 5B.3B.2: currency safety at the signing boundary --------------------------

test("5B.3B.2: USD pricing profile + USD authoritative shop currency → a signed v2 quote is issued (currency USD)", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider({ shopCurrency: "USD" }));
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    assert.ok(result.body.data.cartPricing, "quote issued when profile currency == shop currency");
    const p = JSON.parse(result.body.data.cartPricing!.payload) as Record<string, unknown>;
    assert.equal(p.currency, "USD");
    assert.deepEqual(result.body.data.enforcement, { state: "enforce" });
  });
});

test("5B.3B.2: USD pricing profile + BDT shop currency → NO signed quote (fails BEFORE signing), state block", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider({ shopCurrency: "BDT" }));
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    assert.equal(result.body.data.cartPricing, null, "PROFILE_SHOP_CURRENCY_MISMATCH → no quote, no FX");
    assert.equal(result.body.data.base.netUnitPriceCents, 137, "display pricing is still computed");
    assert.deepEqual(result.body.data.enforcement, { state: "block" }, "an enforced product with a currency mismatch stays contained");
  });
});

test("5B.3B.2: a missing / malformed authoritative shop currency → CURRENCY_CONTEXT_UNAVAILABLE, no quote", async () => {
  await withEnv(V2_ENV, async () => {
    for (const bad of [null, undefined, "US Dollars"]) {
      const result = await v2Result({ quantity: 100 }, fixedProvider({ shopCurrency: bad }));
      assert.equal(result.body.ok, true);
      if (result.body.ok) assert.equal(result.body.data.cartPricing, null, JSON.stringify(bad));
    }
  });
});

test("5B.3B.2: the browser CANNOT supply or override the quote currency", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result(
      { quantity: 100, currency: "EUR", cartCurrency: "EUR", presentmentCurrency: "JPY" },
      fixedProvider({ shopCurrency: "USD" }),
    );
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    assert.ok(result.body.data.cartPricing);
    const p = JSON.parse(result.body.data.cartPricing!.payload) as Record<string, unknown>;
    assert.equal(p.currency, "USD", "currency is the profile/shop currency, never the browser's");
  });
});

test("5B.3B.2: no automatic FX — the quote currency is the profile currency verbatim, never converted", async () => {
  await withEnv(V2_ENV, async () => {
    const result = await v2Result({ quantity: 100 }, fixedProvider({ shopCurrency: "USD" }));
    assert.equal(result.body.ok, true);
    if (!result.body.ok) return;
    const p = JSON.parse(result.body.data.cartPricing!.payload) as Record<string, unknown>;
    // base cents come straight from the engine (netUnitPriceCents) — no rate multiplier applied
    assert.equal(p.baseUnitPriceCents, result.body.data.base.netUnitPriceCents);
    assert.equal(p.currency, "USD");
  });
});
