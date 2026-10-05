import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { approveProof, requestProofRevision } from "../lib/orders/proofs.ts";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const token = params.token ?? "";
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ ok: false, code: "INVALID_JSON" }, { status: 400 }); }
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const actionName = data.action;
  const result = actionName === "approve"
    ? await approveProof(prisma as unknown as Parameters<typeof approveProof>[0], token, typeof data.approvedBy === "string" ? data.approvedBy : "customer")
    : actionName === "revision"
      ? await requestProofRevision(prisma as unknown as Parameters<typeof requestProofRevision>[0], token, typeof data.requestedChanges === "string" ? data.requestedChanges : "")
      : { ok: false as const, code: "INVALID_ACTION" };
  return Response.json(result, { status: result.ok ? 200 : result.code === "INVALID_PROOF_TOKEN" ? 401 : 422 });
};
