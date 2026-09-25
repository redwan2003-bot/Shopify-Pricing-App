import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSubscription } from "@shopify/shopify-api";
import { isTestBillingMode, readEntitlement } from "./entitlement.ts";

test("isTestBillingMode: defaults to 'not production', SHOPIFY_BILLING_TEST_MODE overrides either way", () => {
  const original = { NODE_ENV: process.env.NODE_ENV, override: process.env.SHOPIFY_BILLING_TEST_MODE };
  try {
    delete process.env.SHOPIFY_BILLING_TEST_MODE;
    process.env.NODE_ENV = "production";
    assert.equal(isTestBillingMode(), false, "production with no override is a real-money check");
    process.env.NODE_ENV = "development";
    assert.equal(isTestBillingMode(), true, "non-production defaults to test mode");
    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_BILLING_TEST_MODE = "true";
    assert.equal(isTestBillingMode(), true, "override forces test mode even in production");
    process.env.NODE_ENV = "development";
    process.env.SHOPIFY_BILLING_TEST_MODE = "false";
    assert.equal(isTestBillingMode(), false, "override forces real-money mode even outside production");
  } finally {
    if (original.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original.NODE_ENV;
    if (original.override === undefined) delete process.env.SHOPIFY_BILLING_TEST_MODE;
    else process.env.SHOPIFY_BILLING_TEST_MODE = original.override;
  }
});

test("readEntitlement: an active subscription for the plan is reported with its details", async () => {
  const subscription: AppSubscription = {
    id: "gid://shopify/AppSubscription/1",
    name: "ImprintID Dynamic Pricing Monthly",
    status: "ACTIVE",
    test: true,
    trialDays: 14,
    createdAt: "2026-09-25T00:00:00Z",
    currentPeriodEnd: "2026-10-25T00:00:00Z",
    returnUrl: "https://shopify-pricing-app.onrender.com/app/billing",
    lineItems: [],
  };
  const result = await readEntitlement(async () => ({ hasActivePayment: true, appSubscriptions: [subscription], oneTimePurchases: [] }));
  assert.deepEqual(result, { ok: true, hasActivePayment: true, subscription });
});

test("readEntitlement: no active payment comes back as a clean, non-error 'no subscription' result", async () => {
  const result = await readEntitlement(async () => ({ hasActivePayment: false, appSubscriptions: [], oneTimePurchases: [] }));
  assert.deepEqual(result, { ok: true, hasActivePayment: false, subscription: null });
});

test("readEntitlement: hasActivePayment true with an empty appSubscriptions array is treated as NOT entitled (never crashes on a shape mismatch)", async () => {
  const result = await readEntitlement(async () => ({ hasActivePayment: true, appSubscriptions: [], oneTimePurchases: [] }));
  assert.equal(result.hasActivePayment, false);
});

test("readEntitlement: a transport failure fails closed, never throws", async () => {
  const result = await readEntitlement(async () => {
    throw new Error("network timeout talking to Shopify");
  });
  assert.equal(result.ok, false);
  assert.equal(result.hasActivePayment, false);
  assert.equal(result.subscription, null);
  assert.ok(!result.ok && /network timeout/.test(result.error));
});

test("readEntitlement: a thrown non-Error value still fails closed with a usable message", async () => {
  const result = await readEntitlement(async () => {
    throw "plain string rejection";
  });
  assert.equal(result.ok, false);
  assert.equal(result.hasActivePayment, false);
});
