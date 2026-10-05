import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { advanceProduction } from "../lib/orders/proofs.ts";

type WorkflowDb = {
  store: { findUnique(args: Record<string, unknown>): Promise<{ id: string } | null> };
  orderWorkflow: { findMany(args: Record<string, unknown>): Promise<Array<{ id: string; shopifyOrderId: string; orderNumber: string | null; status: string; currency: string | null; createdAt: Date; _count: { configurations: number; artwork: number; proofs: number } }>> };
};

const db = prisma as unknown as WorkflowDb;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await db.store.findUnique({ where: { shopDomain: session.shop }, select: { id: true } });
  if (!store) return { workflows: [] };
  const workflows = await db.orderWorkflow.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, shopifyOrderId: true, orderNumber: true, status: true, currency: true, createdAt: true, _count: { select: { configurations: true, artwork: true, proofs: true } } },
  });
  return { workflows: workflows.map((workflow) => ({ ...workflow, createdAt: workflow.createdAt.toISOString() })) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const workflowId = String(form.get("workflowId") ?? "");
  const toStatus = String(form.get("toStatus") ?? "");
  if (!workflowId || !["production", "shipped", "completed"].includes(toStatus)) return { ok: false, code: "INVALID_REQUEST" };
  const result = await advanceProduction(prisma as unknown as Parameters<typeof advanceProduction>[0], workflowId, toStatus as "production" | "shipped" | "completed", session.id);
  return result;
};

export default function OrderWorkflows() {
  const { workflows } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <s-page heading="Order workflows">
      <s-section heading="Artwork, proof, and production status">
        {workflows.length === 0 ? <s-paragraph>No Shopify orders with pricing configurations have been captured yet.</s-paragraph> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}><th>Order</th><th>Status</th><th>Pricing lines</th><th>Artwork</th><th>Proofs</th><th>Next action</th></tr></thead>
              <tbody>{workflows.map((workflow) => {
                const next = workflow.status === "approved" ? "production" : workflow.status === "production" ? "shipped" : workflow.status === "shipped" ? "completed" : null;
                return <tr key={workflow.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td>{workflow.orderNumber ?? workflow.shopifyOrderId}</td><td>{workflow.status}</td><td>{workflow._count.configurations}</td><td>{workflow._count.artwork}</td><td>{workflow._count.proofs}</td>
                  <td>{next ? <Form method="post"><input type="hidden" name="workflowId" value={workflow.id} /><input type="hidden" name="toStatus" value={next} /><button type="submit" disabled={busy}>Move to {next}</button></Form> : "—"}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
