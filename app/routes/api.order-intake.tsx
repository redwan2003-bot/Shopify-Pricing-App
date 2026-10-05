import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { submitOrderIntake } from "../lib/orders/intake.ts";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const workflowId = typeof input.workflowId === "string" ? input.workflowId : "";
  if (!workflowId) return Response.json({ ok: false, code: "MISSING_WORKFLOW" }, { status: 400 });
  const result = await submitOrderIntake(prisma as unknown as Parameters<typeof submitOrderIntake>[0], workflowId, input as Parameters<typeof submitOrderIntake>[2]);
  return Response.json(result, { status: result.ok ? 200 : result.code === "NOT_FOUND" ? 404 : 422 });
};
