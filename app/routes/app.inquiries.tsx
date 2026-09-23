import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PAGE_SIZE = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({ where: { shopDomain: session.shop }, select: { id: true } });
  if (!store) return { items: [], newCount: 0 };

  const [items, newCount] = await Promise.all([
    prisma.inquiry.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" }, take: PAGE_SIZE }),
    prisma.inquiry.count({ where: { storeId: store.id, status: "new" } }),
  ]);
  return {
    newCount,
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      status: i.status,
      name: i.name,
      email: i.email,
      message: i.message,
      quantity: i.quantity,
      sku: i.sku,
      shopifyProductId: i.shopifyProductId,
      configuration: i.configuration,
      createdAt: i.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({ where: { shopDomain: session.shop }, select: { id: true } });
  if (!store) return { ok: false };

  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const status = String(form.get("status") ?? "");
  if (!id || (status !== "new" && status !== "handled")) return { ok: false };

  // Store-scoped: an id belonging to another shop matches nothing.
  const result = await prisma.inquiry.updateMany({ where: { id, storeId: store.id }, data: { status } });
  return { ok: result.count === 1 };
};

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function summarize(configuration: string | null): string | null {
  if (!configuration) return null;
  try {
    const c = JSON.parse(configuration) as { displayedTotal?: string; request?: { quantity?: number } };
    const parts = [];
    if (c.request?.quantity) parts.push(`qty ${c.request.quantity}`);
    if (c.displayedTotal && c.displayedTotal !== "—") parts.push(`shown total ${c.displayedTotal}`);
    return parts.length ? parts.join(" · ") : null;
  } catch {
    return null;
  }
}

export default function Inquiries() {
  const { items, newCount } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading="Inquiries">
      <s-section heading={`Customer messages (${newCount} new)`}>
        {items.length === 0 ? (
          <s-paragraph>
            No inquiries yet. Messages sent with “Request Quote” or “Request Info” on a product page appear here.
          </s-paragraph>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                  <th style={{ padding: "0.5rem" }}>Received</th>
                  <th style={{ padding: "0.5rem" }}>Type</th>
                  <th style={{ padding: "0.5rem" }}>From</th>
                  <th style={{ padding: "0.5rem" }}>Message</th>
                  <th style={{ padding: "0.5rem" }}>Product</th>
                  <th style={{ padding: "0.5rem" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} style={{ borderBottom: "1px solid #eee", verticalAlign: "top" }}>
                    <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>{formatWhen(i.createdAt)}</td>
                    <td style={{ padding: "0.5rem" }}>{i.kind === "quote" ? "Quote" : "Info"}</td>
                    <td style={{ padding: "0.5rem" }}>
                      {i.name}
                      <br />
                      <a href={`mailto:${i.email}`}>{i.email}</a>
                    </td>
                    <td style={{ padding: "0.5rem", maxWidth: "28rem", whiteSpace: "pre-wrap" }}>
                      {i.message || <em>(no notes)</em>}
                      {i.quantity ? <div>Quantity requested: {i.quantity}</div> : null}
                      {summarize(i.configuration) ? <div>{summarize(i.configuration)}</div> : null}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {i.sku ?? "—"}
                      {i.shopifyProductId ? (
                        <div>
                          <code>{i.shopifyProductId}</code>
                        </div>
                      ) : null}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      <Form method="post">
                        <input type="hidden" name="id" value={i.id} />
                        <input type="hidden" name="status" value={i.status === "new" ? "handled" : "new"} />
                        <span>{i.status === "new" ? "New" : "Handled"}</span>{" "}
                        <button type="submit" disabled={busy}>
                          {i.status === "new" ? "Mark handled" : "Reopen"}
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <s-page heading="Inquiries">
      <s-section>
        <p role="alert">Something went wrong loading inquiries. Reload the page to try again.</p>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
