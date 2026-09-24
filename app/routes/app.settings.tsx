import type { HeadersFunction } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import type { EnforcementChoice } from "../lib/enforcement/settings.ts";
import { loader, action } from "../lib/enforcement/settings-route.server.ts";

export { loader, action };

const OPTIONS: { value: EnforcementChoice; label: string; help: string }[] = [
  { value: "off", label: "Off", help: "Every product sells at its normal Shopify price. Dynamic pricing is not applied at checkout." },
  {
    value: "pilot",
    label: "On for priced products (recommended)",
    help: "Products that have ImprintID pricing are charged the configured price and can only be bought through the pricing block. All other products sell normally.",
  },
  {
    value: "universal",
    label: "On for every product",
    help: "Every product must have ImprintID pricing. A product without it can't be bought at all.",
  },
  {
    value: "maintenance",
    label: "Paused (pricing incident)",
    help: "Priced products can't be added to cart or checked out until you switch back. Use this if prices look wrong; other products still sell normally.",
  },
];

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading="Settings">
      <s-section heading="Dynamic pricing at checkout">
        {!data.readable ? (
          <s-paragraph>{"Couldn't read the current setting. Reload the page to try again."}</s-paragraph>
        ) : !data.configured ? (
          <s-paragraph>Setup isn&apos;t finished on this store yet. Use Finish setup on the Home page, then come back here.</s-paragraph>
        ) : (
          <Form method="post">
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "0.9rem" }}>
              <legend style={{ marginBottom: "0.5rem" }}>Choose how the app applies pricing:</legend>
              {OPTIONS.map((o) => (
                <label key={o.value} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.5rem", alignItems: "start" }}>
                  <input type="radio" name="choice" value={o.value} defaultChecked={data.current === o.value} style={{ marginTop: "0.25rem" }} />
                  <span>
                    <strong>{o.label}</strong>
                    {data.current === o.value ? " (current)" : ""}
                    <br />
                    <span style={{ color: "#616161" }}>{o.help}</span>
                  </span>
                </label>
              ))}
              <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input type="checkbox" name="confirmUniversal" />
                <span>I understand that &ldquo;On for every product&rdquo; blocks products without ImprintID pricing.</span>
              </label>
              {!data.setupComplete ? <s-paragraph>Setup isn&apos;t finished, so pricing can&apos;t be turned on yet.</s-paragraph> : null}
              {!data.canSignQuotes ? (
                <s-paragraph>The app can&apos;t sign prices on this deployment yet, so pricing can&apos;t be turned on. Off and Paused still work.</s-paragraph>
              ) : null}
              <div>
                <button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </fieldset>
          </Form>
        )}
        {result ? (
          <p role={result.ok ? "status" : "alert"} style={{ marginTop: "1rem", color: result.ok ? "#1a7f37" : "#b42318" }}>
            {result.message}
          </p>
        ) : null}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <s-page heading="Settings">
      <s-section>
        <p role="alert">Something went wrong loading settings. Reload the page to try again.</p>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
