import type { HeadersFunction } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { listLoader } from "../lib/pricing-editor/editor-route.server.ts";

export const loader = listLoader;

export default function AttachmentsIndex() {
  const data = useLoaderData<typeof loader>();
  return <s-page heading="Attachments">
    <s-section><p>Manage attachment groups, codes, and price-per-piece values separately from the rest of each pricing profile.</p><Form method="get" style={{ display: "flex", gap: "0.5rem", alignItems: "end" }}><label style={{ display: "grid", gap: "0.25rem" }}><span>Search by SKU or name</span><input type="search" name="q" defaultValue={data.q} /></label><button type="submit">Search</button></Form></s-section>
    <s-section heading={`${data.total} pricing profile${data.total === 1 ? "" : "s"}`}>
      {data.profiles.length === 0 ? <s-paragraph>No pricing profiles found.</s-paragraph> : <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><th style={{ textAlign: "left" }}>SKU</th><th style={{ textAlign: "left" }}>Name</th><th style={{ textAlign: "left" }}>Option groups</th><th style={{ textAlign: "left" }}>Action</th></tr></thead><tbody>{data.profiles.map((profile) => <tr key={profile.id}><td><Link to={`/app/attachments/${profile.id}`}>{profile.sku || "(no SKU)"}</Link></td><td>{profile.name}</td><td>{profile.optionGroups}</td><td><Link to={`/app/attachments/${profile.id}`}>Edit attachments</Link></td></tr>)}</tbody></table></div>}
    </s-section>
  </s-page>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
