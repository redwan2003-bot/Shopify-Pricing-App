import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server.ts";
import { MONTHLY_PLAN } from "./plan.ts";
import { isTestBillingMode, readEntitlement } from "./entitlement.ts";

/** Loader/action for the Billing page (JSX-free so it can be exercised directly). */

export const billingLoader = async ({ request }: LoaderFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const entitlement = await readEntitlement(billing.check);
  return {
    hasActivePayment: entitlement.hasActivePayment,
    subscription: entitlement.hasActivePayment
      ? { name: entitlement.subscription.name, status: entitlement.subscription.status, test: entitlement.subscription.test, id: entitlement.subscription.id }
      : null,
    checkFailed: !entitlement.ok,
    isTest: isTestBillingMode(),
    planName: MONTHLY_PLAN,
  };
};

export type BillingActionResult = { ok: false; message: string } | { ok: true; message: string };

export const billingAction = async ({ request }: ActionFunctionArgs): Promise<BillingActionResult | Response> => {
  const { billing, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "subscribe") {
    const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
    // billing.request() never returns — it throws a redirect to Shopify's confirmation page.
    return billing.request({
      plan: MONTHLY_PLAN,
      isTest: isTestBillingMode(),
      returnUrl: appUrl ? `${appUrl}/app/billing?shop=${encodeURIComponent(session.shop)}` : undefined,
    });
  }

  if (intent === "cancel") {
    const subscriptionId = String(form.get("subscriptionId") ?? "");
    if (!subscriptionId) return { ok: false, message: "No subscription to cancel." };
    try {
      await billing.cancel({ subscriptionId, isTest: isTestBillingMode() });
      return { ok: true, message: "Subscription cancelled. Existing pricing profiles stay view-only until you resubscribe; your storefront keeps quoting existing prices." };
    } catch (error) {
      return { ok: false, message: `Couldn't cancel: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };
    }
  }

  return { ok: false, message: "Unrecognized request." };
};
