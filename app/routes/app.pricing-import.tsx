import type { HeadersFunction } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { loader, action } from "../lib/pricing-import/import-route.server.ts";

export { loader, action };

const cell = { padding: "0.4rem 0.5rem", borderBottom: "1px solid #eee", verticalAlign: "top" as const };

export default function PricingImport() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busyIntent = navigation.state === "submitting" ? navigation.formData?.get("intent") : null;

  return (
    <s-page heading="Import pricing">
      <s-section heading="Upload your catalog pricing">
        <s-paragraph>
          Upload your catalog CSV (the Shopify product export that includes the “ImprintID Pricing Profile” column). Preview
          first to see what will be imported; nothing changes until you choose Import.
        </s-paragraph>
        <s-paragraph>
          This store currently has {data.profiles} pricing profile{data.profiles === 1 ? "" : "s"}, {data.linked} linked to a
          product.
        </s-paragraph>
        <Form method="post" encType="multipart/form-data" style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}>
          <input type="file" name="catalog" accept=".csv,text/csv" required />
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="submit" name="intent" value="preview" disabled={!!busyIntent}>
              {busyIntent === "preview" ? "Checking…" : "Preview"}
            </button>
            <button type="submit" name="intent" value="import" disabled={!!busyIntent}>
              {busyIntent === "import" ? "Importing — this can take a minute…" : "Import"}
            </button>
          </div>
        </Form>
      </s-section>

      {result && !result.ok ? (
        <s-section>
          <p role="alert" style={{ color: "#b42318", margin: 0 }}>
            {result.message}
          </p>
        </s-section>
      ) : null}

      {result && result.ok ? (
        <s-section heading={result.intent === "import" ? "Import finished" : "Preview"}>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {result.productsWithProfile} products in the file have pricing. {result.ready} can be imported;{" "}
              {result.heldBackTotal} can&apos;t (see below).
            </s-paragraph>
            {result.intent === "import" ? (
              <s-paragraph>
                Imported {result.imported} ({result.changed} with changed prices). Linked {result.linked} to products in your
                store ({result.policiesWritten} updated).
              </s-paragraph>
            ) : null}
            {result.currencyWarning ? (
              <p role="alert" style={{ color: "#8a5a00", margin: 0 }}>
                {result.currencyWarning}
              </p>
            ) : null}
            {result.errors && result.errors.length ? (
              <p role="alert" style={{ color: "#b42318", margin: 0 }}>
                Some product links failed: {result.errors.slice(0, 3).join("; ")}
              </p>
            ) : null}
          </s-stack>

          {result.heldBack.length ? (
            <details style={{ marginTop: "1rem" }}>
              <summary>Not imported ({result.heldBackTotal})</summary>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={cell}>SKU</th>
                      <th style={cell}>Product</th>
                      <th style={cell}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.heldBack.map((h, i) => (
                      <tr key={`${h.sku}-${i}`}>
                        <td style={cell}>{h.sku}</td>
                        <td style={cell}>{h.title || "—"}</td>
                        <td style={cell}>{h.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}

          {result.notLinked && result.notLinked.length ? (
            <details style={{ marginTop: "1rem" }}>
              <summary>Imported but not linked to a product ({result.notLinked.length})</summary>
              <ul>
                {result.notLinked.map((n, i) => (
                  <li key={`${n.sku}-${i}`}>
                    <strong>{n.sku}</strong>: {n.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </s-section>
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <s-page heading="Import pricing">
      <s-section>
        <p role="alert">Something went wrong with the import page. Reload and try again.</p>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
