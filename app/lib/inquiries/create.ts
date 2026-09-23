import type { PrismaClient } from "@prisma/client";

/**
 * Storefront "Request Info" / "Request Quote" messages. The shop always comes from the
 * verified App Proxy session (never the request body), and every field from the browser is
 * validated and length-capped here — this endpoint is public, so nothing in the body is
 * trusted.
 */

export type InquiryKind = "info" | "quote";

export type CreateInquiryResult =
  | { ok: true; id: string }
  | { ok: false; status: number; code: string; message: string };

export const INQUIRY_LIMITS = {
  name: 120,
  email: 254,
  message: 2000,
  sku: 120,
  configuration: 4000,
  maxQuantity: 10_000_000,
  /** more than this many from one email to one shop inside the window is refused */
  throttleCount: 5,
  throttleWindowMs: 10 * 60 * 1000,
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMERIC_ID = /^\d{1,20}$/;

function fail(status: number, code: string, message: string): CreateInquiryResult {
  return { ok: false, status, code, message };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > max ? null : trimmed;
}

export async function createInquiry(
  prisma: PrismaClient,
  shopDomain: string,
  raw: unknown,
  now: Date = new Date(),
): Promise<CreateInquiryResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(400, "INVALID_INQUIRY", "The request could not be read.");
  }
  const body = raw as Record<string, unknown>;

  // Honeypot: a hidden field real visitors never fill in. Pretend success so bots learn nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { ok: true, id: "ignored" };
  }

  const kind = body.kind;
  if (kind !== "info" && kind !== "quote") {
    return fail(400, "INVALID_INQUIRY", "The request could not be read.");
  }

  const name = text(body.name, INQUIRY_LIMITS.name);
  if (!name) return fail(422, "INVALID_NAME", "Please enter your name.");

  const email = text(body.email, INQUIRY_LIMITS.email)?.toLowerCase() ?? null;
  if (!email || !EMAIL_PATTERN.test(email)) return fail(422, "INVALID_EMAIL", "Please enter a valid email address.");

  const message = text(body.message ?? "", INQUIRY_LIMITS.message);
  if (message === null) return fail(422, "INVALID_MESSAGE", "That message is too long.");
  if (kind === "info" && message === "") return fail(422, "INVALID_MESSAGE", "Please enter a message.");

  let quantity: number | null = null;
  if (body.quantity !== undefined && body.quantity !== null && body.quantity !== "") {
    const q = Number(body.quantity);
    if (!Number.isInteger(q) || q < 1 || q > INQUIRY_LIMITS.maxQuantity) {
      return fail(422, "INVALID_QUANTITY", "Please enter a whole number quantity.");
    }
    quantity = q;
  }

  const idField = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null || value === "") return null;
    return typeof value === "string" && NUMERIC_ID.test(value) ? value : undefined;
  };
  const shopifyProductId = idField(body.shopifyProductId);
  const shopifyVariantId = idField(body.shopifyVariantId);
  if (shopifyProductId === undefined || shopifyVariantId === undefined) {
    return fail(400, "INVALID_INQUIRY", "The request could not be read.");
  }

  const skuText = body.sku === undefined || body.sku === null ? "" : text(body.sku, INQUIRY_LIMITS.sku);
  if (skuText === null) return fail(400, "INVALID_INQUIRY", "The request could not be read.");

  // The configuration snapshot is context for the merchant, so an oversized or unserializable
  // one is dropped rather than failing the customer's message.
  let configuration: string | null = null;
  if (body.configuration !== undefined && body.configuration !== null) {
    try {
      const json = JSON.stringify(body.configuration);
      if (json && json.length <= INQUIRY_LIMITS.configuration) configuration = json;
    } catch {
      configuration = null;
    }
  }

  const store = await prisma.store.upsert({
    where: { shopDomain },
    update: {},
    create: { shopDomain },
    select: { id: true },
  });

  const since = new Date(now.getTime() - INQUIRY_LIMITS.throttleWindowMs);
  const recent = await prisma.inquiry.count({ where: { storeId: store.id, email, createdAt: { gte: since } } });
  if (recent >= INQUIRY_LIMITS.throttleCount) {
    return fail(429, "RATE_LIMITED", "You have sent several messages recently. Please wait a few minutes and try again.");
  }

  const created = await prisma.inquiry.create({
    data: {
      storeId: store.id,
      kind,
      name,
      email,
      message,
      quantity,
      shopifyProductId,
      shopifyVariantId,
      sku: skuText || null,
      configuration,
    },
    select: { id: true },
  });
  return { ok: true, id: created.id };
}
