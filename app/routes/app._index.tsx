import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Read-only overview of the pricing data configured for the calling shop. This loader
 * only counts existing rows — it does not create a Store, mutate pricing data, or run
 * any pricing calculation. Pricing profile management (CRUD) is intentionally not part
 * of this page.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

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
    };
  }

  const [profileCount, activeProfileCount, configuredProductCount] =
    await Promise.all([
      prisma.pricingProfile.count({ where: { storeId: store.id } }),
      prisma.pricingProfile.count({
        where: { storeId: store.id, isActive: true },
      }),
      prisma.productPricingOverride.count({
        where: { storeId: store.id, isActive: true },
      }),
    ]);

  return {
    configured: true as const,
    shopDomain: session.shop,
    profileCount,
    activeProfileCount,
    configuredProductCount,
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();

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

      <s-section slot="aside" heading="Tools">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/app/product-configuration">
              Product configuration preview
            </s-link>
            {" — step through a product's options and see the calculated quote."}
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
