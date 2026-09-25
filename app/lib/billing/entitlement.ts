import type { AppSubscription } from "@shopify/shopify-api";
// Type-only: erased at build time, so importing this does NOT execute shopify.server.ts (which
// throws without SHOPIFY_APP_URL/SHOPIFY_API_KEY set) — this module stays safely unit-testable.
import type { authenticate } from "../../shopify.server.ts";
import { MONTHLY_PLAN } from "./plan.ts";

/**
 * Whether billing.check()/request() should run in Shopify's test-charge mode (no real money
 * moves; required for development/Partner-sandbox stores, which the API refuses to charge for
 * real regardless of this flag). Defaults to "not production"; SHOPIFY_BILLING_TEST_MODE can
 * force either way for a controlled rollout (e.g. testing real-store billing before flipping
 * production traffic to real charges).
 */
export function isTestBillingMode(): boolean {
  const override = process.env.SHOPIFY_BILLING_TEST_MODE?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export type EntitlementStatus =
  | { ok: true; hasActivePayment: true; subscription: AppSubscription }
  | { ok: true; hasActivePayment: false; subscription: null }
  | { ok: false; hasActivePayment: false; subscription: null; error: string };

type AdminContext = Awaited<ReturnType<typeof authenticate.admin>>;
type BillingCheck = AdminContext["billing"]["check"];

/**
 * Reads whether the shop has an active payment for the app's plan. Never throws — a transport
 * failure comes back as `{ ok: false, hasActivePayment: false }` so callers fail closed (an
 * unconfirmed subscription is treated the same as no subscription), matching this app's existing
 * pattern for `readShopPolicyContext`.
 */
export async function readEntitlement(billingCheck: BillingCheck): Promise<EntitlementStatus> {
  try {
    const result = await billingCheck({ plans: [MONTHLY_PLAN], isTest: isTestBillingMode() });
    if (result.hasActivePayment && result.appSubscriptions[0]) {
      return { ok: true, hasActivePayment: true, subscription: result.appSubscriptions[0] };
    }
    return { ok: true, hasActivePayment: false, subscription: null };
  } catch (error) {
    return {
      ok: false,
      hasActivePayment: false,
      subscription: null,
      error: error instanceof Error ? error.message.slice(0, 200) : "billing check failed",
    };
  }
}
