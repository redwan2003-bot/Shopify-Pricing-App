import { canTransition } from "./workflow-state.ts";

type IntakeClient = {
  orderWorkflow: {
    findUnique(args: Record<string, unknown>): Promise<{ id: string; status: string } | null>;
    update(args: Record<string, unknown>): Promise<{ id: string; status: string }>;
  };
};

export interface OrderIntakeInput {
  poNumber?: string;
  eventDate?: string;
  inHandsDate?: string;
  shipToAddress?: string;
  imprintInstructions?: string;
  associationNumbers?: string;
  notes?: string;
  artwork?: Array<{ objectKey: string; filename: string; contentType: string; byteSize: number; checksum?: string }>;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function date(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export async function submitOrderIntake(
  prisma: IntakeClient,
  workflowId: string,
  input: OrderIntakeInput,
) {
  const workflow = await prisma.orderWorkflow.findUnique({ where: { id: workflowId }, select: { id: true, status: true } });
  if (!workflow) return { ok: false as const, code: "NOT_FOUND" };
  if (!canTransition(workflow.status, "artwork_pending") && workflow.status !== "artwork_pending") {
    return { ok: false as const, code: "INVALID_STATUS" };
  }
  const artwork = input.artwork ?? [];
  if (artwork.some((file) => !text(file.objectKey, 512) || !text(file.filename, 255) || !text(file.contentType, 120) || !Number.isInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > 50_000_000)) {
    return { ok: false as const, code: "INVALID_ARTWORK" };
  }
  const updated = await prisma.orderWorkflow.update({
    where: { id: workflowId },
    data: {
      status: "artwork_pending",
      poNumber: text(input.poNumber, 120),
      eventDate: date(input.eventDate),
      inHandsDate: date(input.inHandsDate),
      shipToAddress: text(input.shipToAddress, 4000),
      imprintInstructions: text(input.imprintInstructions, 4000),
      associationNumbers: text(input.associationNumbers, 500),
      notes: text(input.notes, 4000),
      events: { create: { fromStatus: workflow.status, toStatus: "artwork_pending", actorType: "customer" } },
      artwork: { create: artwork.map((file) => ({ objectKey: file.objectKey.trim(), filename: file.filename.trim(), contentType: file.contentType.trim(), byteSize: file.byteSize, checksum: text(file.checksum, 128) })) },
    },
    select: { id: true, status: true },
  });
  return { ok: true as const, workflow: updated };
}
