import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
// Registers the global JSX types for the App Bridge custom elements used below
// (e.g. <s-app-nav>). Loaded here because this layout is where those elements render.
import "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getAdminNavigation } from "../lib/admin/navigation.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", navigation: getAdminNavigation() };
};

export default function App() {
  const { apiKey, navigation } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {navigation.map((item) => (
          <s-link key={item.href} href={item.href}>{item.label}</s-link>
        ))}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
