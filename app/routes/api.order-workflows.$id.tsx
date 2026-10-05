import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { advanceProduction } from "../lib/orders/proofs.ts";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const toStatus = body && typeof body === "object" && "toStatus" in body ? body.toStatus : null;
  if (toStatus !== "production" && toStatus !== "shipped" && toStatus !== "completed") return Response.json({ ok: false, code: "INVALID_STATUS" }, { status: 422 });
  const result = await advanceProduction(prisma as unknown as Parameters<typeof advanceProduction>[0], params.id ?? "", toStatus, session.id);
  return Response.json(result, { status: result.ok ? 200 : 422 });
};
