import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import {
  createDefaultCartPricingPolicyProvider,
  cartPricingEnforcementUiState,
} from "./cart-pricing-policy-provider.ts";
import type { CartPricingPolicyDecision } from "./cart-signature.ts";
import type { AdminGraphqlClientLike } from "./product-resolver.ts";

/**
 * Task 5B.3A.1 — the production `CartPricingPolicyProvider` returns the AUTHORITATIVE
 * THREE-STATE decision (`enforce` | `bypass` | `block`) read ONLY from the app-owned
 * `$app:imprintid/enforcement_policy` (shop) + `$app:imprintid/pricing_policy` (product)
 * metafields. `bypass` is reserved for an EXPLICIT safe-native-bypass (disabled shop /
 * pilot-unmarked product); everything else that isn't `enforce` is `block`.
 *
 * `prisma` is unused by the provider today — passed as a stub so the shape matches
 * production.
 */
const prismaStub = {} as unknown as PrismaClient;

const ADJ = "gid://shopify/ProductVariant/999";
const PRODUCT_ID = "9442404663548";

function admin(
  shopJson: unknown,
  productJson: unknown,
  opts: { throw?: boolean; noData?: boolean; shopCurrency?: unknown } = {},
): AdminGraphqlClientLike {
  const currencyCode = "shopCurrency" in opts ? opts.shopCurrency : "USD";
  return {
    async graphql() {
      if (opts.throw) throw new Error("network");
      if (opts.noData) return { json: async () => ({}) };
      return {
        json: async () => ({
          data: {
            shop: { currencyCode, metafield: shopJson === undefined ? null : { jsonValue: shopJson } },
            product: { metafield: productJson === undefined ? null : { jsonValue: productJson } },
          },
        }),
      };
    },
  };
}

const goodShop = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  mode: "pilot",
  enabled: true,
  adjustmentVariantGid: ADJ,
  installBinding: "install-binding-abc123",
  policyRevision: 7,
  ...over,
});
const goodProduct = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  required: true,
  active: true,
  profileRef: "prof_LNY01",
  profileRevision: 12,
  policyRevision: 7,
  ...over,
});

const ARGS = { shopDomain: "s.myshopify.com", shopifyProductId: PRODUCT_ID };

async function decide(
  shop: unknown,
  product: unknown,
  opts?: { throw?: boolean; noData?: boolean; shopCurrency?: unknown },
): Promise<CartPricingPolicyDecision> {
  return createDefaultCartPricingPolicyProvider({ prisma: prismaStub, admin: admin(shop, product, opts) }).resolve(ARGS);
}

// --- enforce -----------------------------------------------------------------------

test("valid shop + product policy (pilot, required + active) → enforce with the full context", async () => {
  const d = await decide(goodShop(), goodProduct());
  assert.deepEqual(d, {
    action: "enforce",
    context: {
      installBinding: "install-binding-abc123",
      adjustmentVariantGid: ADJ,
      policyRevision: 7,
      profileRef: "prof_LNY01",
      profileRevision: 12,
      shopCurrency: "USD",
    },
  });
});

test("universal mode + any active product policy → enforce", async () => {
  const d = await decide(goodShop({ mode: "universal" }), goodProduct({ required: false, active: true }));
  assert.equal(d.action, "enforce");
});

// --- Task 5B.3B.2: shop currency carried on the enforce decision ---------------------

test("5B.3B.2: an `enforce` decision carries the normalized Admin shop currency in context", async () => {
  const d = await decide(goodShop(), goodProduct(), { shopCurrency: "bdt" });
  assert.equal(d.action, "enforce");
  if (d.action === "enforce") assert.equal(d.context.shopCurrency, "BDT");
});

test("5B.3B.2: a missing / malformed Admin shop currency → context.shopCurrency is null (signer then fails closed)", async () => {
  for (const bad of [null, undefined, "", "US Dollars", 123]) {
    const d = await decide(goodShop(), goodProduct(), { shopCurrency: bad });
    assert.equal(d.action, "enforce", JSON.stringify(bad));
    if (d.action === "enforce") assert.equal(d.context.shopCurrency, null, JSON.stringify(bad));
  }
});

// --- bypass (explicit, safe) -----------------------------------------------------

test("shop policy mode `disabled` → bypass:shop_disabled", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "disabled" }), goodProduct()), { action: "bypass", reason: "shop_disabled" });
});

test("shop policy `enabled:false` → bypass:shop_disabled", async () => {
  assert.deepEqual(await decide(goodShop({ enabled: false }), goodProduct()), { action: "bypass", reason: "shop_disabled" });
});

test("pilot mode, product metafield GENUINELY ABSENT → bypass:pilot_unmarked", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "pilot" }), undefined), { action: "bypass", reason: "pilot_unmarked" });
});

test("pilot mode, product policy present but `required:false` → bypass:pilot_unmarked", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "pilot" }), goodProduct({ required: false })), {
    action: "bypass",
    reason: "pilot_unmarked",
  });
});

// --- block (mandatory fail-closed) ---------------------------------------------------

test("no Admin client → block:provider_failure", async () => {
  const d = await createDefaultCartPricingPolicyProvider({ prisma: prismaStub, admin: null }).resolve(ARGS);
  assert.deepEqual(d, { action: "block", reason: "provider_failure" });
});

test("no shopifyProductId → block:provider_failure", async () => {
  const d = await createDefaultCartPricingPolicyProvider({ prisma: prismaStub, admin: admin(goodShop(), goodProduct()) }).resolve({
    ...ARGS,
    shopifyProductId: null,
  });
  assert.deepEqual(d, { action: "block", reason: "provider_failure" });
});

test("GraphQL throws / returns no data → block:provider_failure (never surfaces the error)", async () => {
  assert.deepEqual(await decide(goodShop(), goodProduct(), { throw: true }), { action: "block", reason: "provider_failure" });
  assert.deepEqual(await decide(goodShop(), goodProduct(), { noData: true }), { action: "block", reason: "provider_failure" });
});

test("shop policy metafield ABSENT → block:shop_policy_missing", async () => {
  assert.deepEqual(await decide(undefined, goodProduct()), { action: "block", reason: "shop_policy_missing" });
});

test("shop policy present but MALFORMED → block:shop_policy_malformed", async () => {
  for (const bad of [
    goodShop({ extra: 1 }),
    goodShop({ schema: 2 }),
    goodShop({ adjustmentVariantGid: "999" }),
    goodShop({ policyRevision: 0 }),
    goodShop({ installBinding: "" }),
    { not: "a policy" },
  ]) {
    assert.deepEqual(await decide(bad, goodProduct()), { action: "block", reason: "shop_policy_malformed" }, JSON.stringify(bad));
  }
});

test("shop policy mode `maintenance` → block:maintenance", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "maintenance" }), goodProduct()), { action: "block", reason: "maintenance" });
});

test("pilot mode, product metafield PRESENT but malformed → block:product_policy_malformed", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "pilot" }), goodProduct({ profileRevision: -1 })), {
    action: "block",
    reason: "product_policy_malformed",
  });
});

test("pilot mode, product `required:true` + `active:false` → block:required_policy_inactive", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "pilot" }), goodProduct({ required: true, active: false })), {
    action: "block",
    reason: "required_policy_inactive",
  });
});

test("universal mode, product metafield ABSENT → block:universal_policy_missing", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "universal" }), undefined), {
    action: "block",
    reason: "universal_policy_missing",
  });
});

test("universal mode, product present but malformed → block:product_policy_malformed", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "universal" }), goodProduct({ active: "yes" })), {
    action: "block",
    reason: "product_policy_malformed",
  });
});

test("universal mode, product `active:false` → block:required_policy_inactive", async () => {
  assert.deepEqual(await decide(goodShop({ mode: "universal" }), goodProduct({ active: false })), {
    action: "block",
    reason: "required_policy_inactive",
  });
});

// --- cartPricingEnforcementUiState -------------------------------------------------

test("cartPricingEnforcementUiState: bypass/block pass through; enforce downgrades to block when it cannot sign", () => {
  const enforce: CartPricingPolicyDecision = {
    action: "enforce",
    context: { installBinding: "i", adjustmentVariantGid: ADJ, policyRevision: 1, profileRef: "p", profileRevision: 1 },
  };
  assert.equal(cartPricingEnforcementUiState(enforce, true), "enforce");
  assert.equal(cartPricingEnforcementUiState(enforce, false), "block");
  assert.equal(cartPricingEnforcementUiState({ action: "bypass", reason: "shop_disabled" }, true), "bypass");
  assert.equal(cartPricingEnforcementUiState({ action: "bypass", reason: "shop_disabled" }, false), "bypass");
  assert.equal(cartPricingEnforcementUiState({ action: "block", reason: "maintenance" }, true), "block");
});
