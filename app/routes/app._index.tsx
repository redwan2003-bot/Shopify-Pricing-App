import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { readShopPolicyContext } from "../lib/catalog/admin-client.ts";
import { parseShopEnforcementPolicy } from "../lib/pricing-api/policy-metafields.ts";
import { provisionShop, provisionStatusFrom, readProvisionState, type ProvisionStep } from "../lib/provisioning/provision-shop.ts";

const STEP_LABEL: Record<ProvisionStep, string> = {
  definitions: "pricing data fields",
  adjustment_product: "hidden pricing-adjustment product",
  shop_policy: "store pricing policy",
  cart_transform: "cart pricing function",
  validation: "checkout validation",
};

type EnforcementSummary =
  | { state: "unreadable" }
  | { state: "not_configured" }
  | { state: "configured"; enabled: boolean; mode: string };

const MODE_EXPLANATION: Record<string, string> = {
  disabled: "Dynamic-pricing enforcement is off; products sell at their normal Shopify price.",
  pilot: "Only products with an active pricing policy are enforced; every other product sells normally.",
  universal: "Every product must carry an active pricing policy and a valid quote to be bought.",
  maintenance: "Enforced products are blocked from cart and checkout while pricing is being fixed.",
};

/**
 * Read-only overview of the pricing data configured for the calling shop. This loader
 * only counts existing rows — it does not create a Store, mutate pricing data, or run
 * any pricing calculation. Pricing profile management (CRUD) is intentionally not part
 * of this page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  let setup: { state: "complete" } | { state: "incomplete"; missing: string[] } | { state: "unknown" } = { state: "unknown" };
  try {
    const status = provisionStatusFrom(await readProvisionState(admin));
    setup = status.complete ? { state: "complete" } : { state: "incomplete", missing: status.missing.map((m) => STEP_LABEL[m]) };
  } catch {
    setup = { state: "unknown" };
  }

  // Read-only: show what the shop is actually set to. A failed read is reported as such,
  // never as "enforcement is off".
  let enforcement: EnforcementSummary = { state: "unreadable" };
  try {
    const context = await readShopPolicyContext(admin);
    if (context.ok) {
      const parsed = context.enforcementPolicyJson === null ? null : parseShopEnforcementPolicy(context.enforcementPolicyJson);
      enforcement = parsed
        ? { state: "configured", enabled: parsed.enabled, mode: parsed.mode }
        : { state: "not_configured" };
    }
  } catch {
    enforcement = { state: "unreadable" };
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true, createdAt: true },
  });

  if (!store) {
    return {
      configured: false as const,
      shopDomain: session.shop,
      profileCount: 0,
      activeProfileCount: 0,
      configuredProductCount: 0,
      newInquiries: 0,
      enforcement,
      setup,
    };
  }

  const [profileCount, activeProfileCount, configuredProductCount, newInquiries] =
    await Promise.all([
      prisma.pricingProfile.count({ where: { storeId: store.id } }),
      prisma.pricingProfile.count({
        where: { storeId: store.id, isActive: true },
      }),
      prisma.productPricingOverride.count({
        where: { storeId: store.id, isActive: true },
      }),
      prisma.inquiry.count({ where: { storeId: store.id, status: "new" } }),
    ]);

  return {
    configured: true as const,
    shopDomain: session.shop,
    profileCount,
    activeProfileCount,
    configuredProductCount,
    newInquiries,
    enforcement,
    setup,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const report = await provisionShop(admin);
  return report.ok
    ? { ok: true as const, message: report.changed.length ? "Setup finished." : "Everything was already set up." }
    : { ok: false as const, message: `Setup stopped at the ${STEP_LABEL[report.failedStep ?? "definitions"]}: ${report.error ?? "unknown error"}` };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading="ImprintID Dynamic Pricing">
      <s-section heading="Overview">
        <s-paragraph>
          ImprintID Dynamic Pricing manages product-specific pricing rules —
          quantity breaks, decoration charges, option surcharges, and production
          options — and quotes them live on the storefront product page. Prices
          are calculated and signed on the server, then verified again by the
          cart transform so the configured amount is the amount charged.
        </s-paragraph>
      </s-section>

      {data.configured ? (
        <s-section heading="Configured pricing">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text>Pricing profiles: </s-text>
              <s-text>
                {data.activeProfileCount} active
                {data.profileCount !== data.activeProfileCount
                  ? ` (${data.profileCount} total)`
                  : ""}
              </s-text>
            </s-paragraph>
            <s-paragraph>
              <s-text>Products with a pricing override: </s-text>
              <s-text>{data.configuredProductCount}</s-text>
            </s-paragraph>
          </s-stack>
        </s-section>
      ) : (
        <s-section heading="No pricing configured yet">
          <s-paragraph>
            No pricing profiles have been set up for{" "}
            <s-text>{data.shopDomain}</s-text> yet. Once profiles exist, this
            page summarizes them and the products they apply to.
          </s-paragraph>
        </s-section>
      )}

      <s-section heading="Setup">
        {data.setup.state === "complete" ? (
          <s-paragraph>Everything dynamic pricing needs on this store is in place.</s-paragraph>
        ) : data.setup.state === "incomplete" ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>Setup isn&apos;t finished. Still missing: {data.setup.missing.join(", ")}.</s-paragraph>
            <Form method="post">
              <button type="submit" disabled={busy}>
                {busy ? "Finishing setup…" : "Finish setup"}
              </button>
            </Form>
          </s-stack>
        ) : (
          <s-paragraph>{"Couldn't check setup right now. Reload the page to try again."}</s-paragraph>
        )}
        {actionData ? <s-paragraph>{actionData.message}</s-paragraph> : null}
      </s-section>

      <s-section heading="Enforcement">
        <s-paragraph>
          <s-link href="/app/settings">Change in Settings</s-link>
        </s-paragraph>
        {data.enforcement.state === "configured" ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text>Status: </s-text>
              <s-text>
                {data.enforcement.enabled ? "On" : "Off"} · mode {data.enforcement.mode}
              </s-text>
            </s-paragraph>
            <s-paragraph>
              {data.enforcement.enabled
                ? (MODE_EXPLANATION[data.enforcement.mode] ?? "")
                : MODE_EXPLANATION.disabled}
            </s-paragraph>
          </s-stack>
        ) : data.enforcement.state === "not_configured" ? (
          <s-paragraph>Enforcement has not been set up for this shop yet, so products sell at their normal price.</s-paragraph>
        ) : (
          <s-paragraph>{"Couldn't read the enforcement setting right now. Reload the page to try again."}</s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Tools">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/app/product-configuration">
              Product configuration preview
            </s-link>
            {" — step through a product's options and see the calculated quote."}
          </s-list-item>
          <s-list-item>
            <s-link href="/app/inquiries">Inquiries</s-link>
            {data.newInquiries > 0 ? ` — ${data.newInquiries} new` : " — customer quote and info requests."}
          </s-list-item>
          <s-list-item>
            <s-link href="/app/catalog">Catalog management</s-link>
            {" — link pricing profiles to products."}
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
