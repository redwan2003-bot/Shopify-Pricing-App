import type { HeadersFunction } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { listLoader } from "../lib/pricing-editor/editor-route.server.ts";

export const loader = listLoader;

const cell = { padding: "0.45rem 0.5rem", borderBottom: "1px solid #eee", textAlign: "left" as const, verticalAlign: "top" as const };

export default function PricingProfiles() {
  const data = useLoaderData<typeof loader>();
  return (
    <s-page heading="Pricing profiles">
      <s-section>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "end", justifyContent: "space-between" }}>
          <Form method="get" style={{ display: "flex", gap: "0.5rem", alignItems: "end" }}>
            <label style={{ display: "grid", gap: "0.25rem" }}>
              <span>Search by SKU or name</span>
              <input type="search" name="q" defaultValue={data.q} />
            </label>
            <button type="submit">Search</button>
          </Form>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Link to="/app/pricing-import">Import from CSV</Link>
            <Link to="/app/pricing-profiles/new">Add profile</Link>
          </div>
        </div>
      </s-section>
      <s-section heading={`${data.total} profile${data.total === 1 ? "" : "s"}${data.q ? ` matching “${data.q}”` : ""}`}>
        {data.profiles.length === 0 ? (
          <s-paragraph>No pricing profiles yet. Import your catalog CSV or add one by hand.</s-paragraph>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead>
                <tr>
                  <th style={cell}>SKU</th>
                  <th style={cell}>Name</th>
                  <th style={cell}>Quantity breaks</th>
                  <th style={cell}>Option groups</th>
                  <th style={cell}>Linked product</th>
                  <th style={cell}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.profiles.map((p) => (
                  <tr key={p.id}>
                    <td style={cell}>
                      <Link to={`/app/pricing-profiles/${p.id}`}>{p.sku || "(no SKU)"}</Link>
                    </td>
                    <td style={cell}>
                      {p.name}
                      {p.isActive ? "" : " (inactive)"}
                    </td>
                    <td style={cell}>{p.tiers}</td>
                    <td style={cell}>{p.optionGroups}</td>
                    <td style={cell}>{p.linkedProducts.length ? p.linkedProducts.join(", ") : <span style={{ color: "#8a5a00" }}>Not linked</span>}</td>
                    <td style={cell}>{new Date(p.updatedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.total > data.profiles.length ? (
              <s-paragraph>
                Showing the first {data.profiles.length}. Search to narrow the list.
              </s-paragraph>
            ) : null}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <s-page heading="Pricing profiles">
      <s-section>
        <p role="alert">Something went wrong loading pricing profiles. Reload the page to try again.</p>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
