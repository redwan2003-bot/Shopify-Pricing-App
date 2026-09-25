import type { HeadersFunction } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { billingAction, billingLoader } from "../lib/billing/billing-route.server.ts";

export const loader = billingLoader;
export const action = billingAction;

export default function Billing() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading="Billing">
      <s-section heading={data.planName}>
        {data.isTest ? (
          <p style={{ color: "#8a5a00" }}>Test mode is on for this environment — subscribing here will not charge a real card.</p>
        ) : null}
        {data.checkFailed ? (
          <p role="alert" style={{ color: "#b42318" }}>
            Couldn&apos;t confirm your subscription status right now. Editing pricing profiles is unavailable until this is resolved; your storefront keeps quoting existing prices either way.
          </p>
        ) : null}
        {result ? (
          <p role={result.ok ? "status" : "alert"} style={{ color: result.ok ? "#1a7f37" : "#b42318" }}>
            {result.message}
          </p>
        ) : null}

        {data.hasActivePayment && data.subscription ? (
          <>
            <p>
              Active — <strong>{data.subscription.name}</strong> ({data.subscription.status}
              {data.subscription.test ? ", test charge" : ""}).
            </p>
            <p style={{ color: "#616161" }}>
              Cancelling stops future charges immediately. Existing pricing profiles become view-only, but your storefront keeps
              quoting whatever prices are already saved — nothing changes for shoppers.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="cancel" />
              <input type="hidden" name="subscriptionId" value={data.subscription.id} />
              <button type="submit" disabled={busy}>
                {busy ? "Working…" : "Cancel subscription"}
              </button>
            </Form>
          </>
        ) : (
          <>
            <p>$29.99/month, 14-day free trial. Subscribing lets you create and edit pricing profiles.</p>
            <p style={{ color: "#616161" }}>
              Already-linked products keep quoting their saved prices on your storefront whether or not you&apos;re subscribed —
              this only gates editing.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="subscribe" />
              <button type="submit" disabled={busy}>
                {busy ? "Redirecting…" : "Subscribe"}
              </button>
            </Form>
          </>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <s-page heading="Billing">
      <s-section>
        <p role="alert">Something went wrong loading billing status. Reload the page to try again.</p>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
