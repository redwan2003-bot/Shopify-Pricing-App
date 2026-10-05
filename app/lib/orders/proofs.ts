import { canTransition, createProofToken, hashProofToken } from "./workflow-state.ts";

type ProofClient = {
  orderWorkflow: {
    findUnique(args: Record<string, unknown>): Promise<{ id?: string; status: string } | null>;
    update(args: Record<string, unknown>): Promise<{ id: string; status: string }>;
  };
  orderProof: {
    findFirst(args: Record<string, unknown>): Promise<{ id: string; workflowId: string; status: string; tokenExpiresAt: Date | null } | null>;
    count(args: Record<string, unknown>): Promise<number>;
    create(args: Record<string, unknown>): Promise<{ id: string; version: number; status: string }>;
    update(args: Record<string, unknown>): Promise<unknown>;
  };
};

export async function publishProof(prisma: ProofClient, workflowId: string, objectKey: string, expiresAt: Date) {
  const workflow = await prisma.orderWorkflow.findUnique({ where: { id: workflowId }, select: { id: true, status: true } });
  if (!workflow || !objectKey.trim() || expiresAt <= new Date()) return { ok: false as const, code: "INVALID_PROOF" };
  if (!canTransition(workflow.status, "proof_ready")) return { ok: false as const, code: "INVALID_STATUS" };
  const previous = await prisma.orderProof.findFirst({ where: { workflowId, status: { in: ["ready", "revision_requested"] } }, orderBy: { version: "desc" }, select: { id: true } });
  const version = (await prisma.orderProof.count({ where: { workflowId } })) + 1;
  const token = createProofToken();
  const proof = await prisma.orderProof.create({ data: { workflowId, version, objectKey: objectKey.trim(), tokenHash: token.tokenHash, tokenExpiresAt: expiresAt }, select: { id: true, version: true, status: true } });
  if (previous) await prisma.orderProof.update({ where: { id: previous.id }, data: { status: "superseded" } });
  await prisma.orderWorkflow.update({ where: { id: workflowId }, data: { status: "proof_ready", events: { create: { fromStatus: workflow.status, toStatus: "proof_ready", actorType: "staff", metadata: JSON.stringify({ proofId: proof.id }) } } } });
  return { ok: true as const, proof, token: token.token };
}

export async function requestProofRevision(prisma: ProofClient, token: string, requestedChanges: string) {
  const proof = await prisma.orderProof.findFirst({ where: { tokenHash: hashProofToken(token) }, select: { id: true, workflowId: true, status: true, tokenExpiresAt: true } });
  if (!proof || proof.status !== "ready" || !proof.tokenExpiresAt || proof.tokenExpiresAt <= new Date() || requestedChanges.trim().length === 0) return { ok: false as const, code: "INVALID_PROOF_TOKEN" };
  const workflow = await prisma.orderWorkflow.findUnique({ where: { id: proof.workflowId }, select: { status: true } });
  if (!workflow || !canTransition(workflow.status, "revision_requested")) return { ok: false as const, code: "INVALID_STATUS" };
  await prisma.orderProof.update({ where: { id: proof.id }, data: { status: "revision_requested", requestedChanges: requestedChanges.trim().slice(0, 4000) } });
  await prisma.orderWorkflow.update({ where: { id: proof.workflowId }, data: { status: "revision_requested", events: { create: { fromStatus: workflow.status, toStatus: "revision_requested", actorType: "customer", note: requestedChanges.trim().slice(0, 4000) } } } });
  return { ok: true as const };
}

export async function approveProof(prisma: ProofClient, token: string, approvedBy: string) {
  const proof = await prisma.orderProof.findFirst({ where: { tokenHash: hashProofToken(token) }, select: { id: true, workflowId: true, status: true, tokenExpiresAt: true } });
  if (!proof || proof.status !== "ready" || !proof.tokenExpiresAt || proof.tokenExpiresAt <= new Date()) return { ok: false as const, code: "INVALID_PROOF_TOKEN" };
  const workflow = await prisma.orderWorkflow.findUnique({ where: { id: proof.workflowId }, select: { status: true } });
  if (!workflow || !canTransition(workflow.status, "approved")) return { ok: false as const, code: "INVALID_STATUS" };
  await prisma.orderProof.update({ where: { id: proof.id }, data: { status: "approved", approvedAt: new Date(), approvedBy: approvedBy.trim().slice(0, 255) } });
  await prisma.orderWorkflow.update({ where: { id: proof.workflowId }, data: { status: "approved", events: { create: { fromStatus: workflow.status, toStatus: "approved", actorType: "customer", actorId: approvedBy.trim().slice(0, 255) } } } });
  return { ok: true as const };
}

export async function advanceProduction(prisma: ProofClient, workflowId: string, toStatus: "production" | "shipped" | "completed", actorId: string) {
  const workflow = await prisma.orderWorkflow.findUnique({ where: { id: workflowId }, select: { status: true } });
  if (!workflow || !canTransition(workflow.status, toStatus)) return { ok: false as const, code: "INVALID_STATUS" };
  const updated = await prisma.orderWorkflow.update({ where: { id: workflowId }, data: { status: toStatus, events: { create: { fromStatus: workflow.status, toStatus, actorType: "staff", actorId: actorId.trim().slice(0, 255) } } }, select: { id: true, status: true } });
  return { ok: true as const, workflow: updated };
}
