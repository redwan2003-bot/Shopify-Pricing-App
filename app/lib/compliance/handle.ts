import type { PrismaClient } from "@prisma/client";

/**
 * Shopify's three mandatory privacy webhooks. Every public app must subscribe to them and
 * answer 200; what the app does with each is its own responsibility.
 *
 * The only personal data this app keeps about a shop's customers is what a storefront
 * visitor typed into "Request Info" / "Request Quote" (name, email, message) — the
 * `Inquiry` table. It stores no orders, no customer records and no addresses.
 *
 *   customers/data_request  the customer asked what is held about them. The merchant is the
 *                           data controller and reads every inquiry on the app's Inquiries
 *                           page, so this records that the request arrived and reports how
 *                           many inquiries match; there is nothing to send back to Shopify.
 *   customers/redact        delete that customer's inquiries for this shop.
 *   shop/redact             sent 48 hours after uninstall: delete everything held for the shop.
 */

export type ComplianceTopic = "customers/data_request" | "customers/redact" | "shop/redact";

export type ComplianceResult =
  | { handled: true; topic: ComplianceTopic; inquiriesMatched?: number; inquiriesDeleted?: number; shopDataDeleted?: boolean }
  | { handled: false; reason: string };

/** Accepts both `customers/data_request` and the `CUSTOMERS_DATA_REQUEST` form the SDK reports. */
export function normalizeComplianceTopic(topic: string): ComplianceTopic | null {
  const t = topic.trim().toLowerCase().replace(/_/g, "/");
  if (t === "customers/data/request") return "customers/data_request";
  if (t === "customers/redact") return "customers/redact";
  if (t === "shop/redact") return "shop/redact";
  return null;
}

function customerEmail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const customer = (payload as { customer?: unknown }).customer;
  if (!customer || typeof customer !== "object") return null;
  const email = (customer as { email?: unknown }).email;
  return typeof email === "string" && email.trim() !== "" ? email.trim().toLowerCase() : null;
}

export async function handleComplianceWebhook(
  prisma: PrismaClient,
  hook: { shop: string; topic: string; payload: unknown },
): Promise<ComplianceResult> {
  const topic = normalizeComplianceTopic(hook.topic);
  if (!topic) return { handled: false, reason: `not a compliance topic: ${hook.topic}` };

  if (topic === "shop/redact") {
    // Store cascades to its pricing, catalog, inquiry and webhook rows.
    const deletedStores = await prisma.store.deleteMany({ where: { shopDomain: hook.shop } });
    await prisma.session.deleteMany({ where: { shop: hook.shop } });
    return { handled: true, topic, shopDataDeleted: deletedStores.count > 0 };
  }

  const email = customerEmail(hook.payload);
  const store = await prisma.store.findUnique({ where: { shopDomain: hook.shop }, select: { id: true } });
  // Nothing held for this shop or customer is a valid, complete answer.
  if (!store || !email) {
    return topic === "customers/data_request"
      ? { handled: true, topic, inquiriesMatched: 0 }
      : { handled: true, topic, inquiriesDeleted: 0 };
  }

  if (topic === "customers/data_request") {
    const inquiriesMatched = await prisma.inquiry.count({ where: { storeId: store.id, email } });
    return { handled: true, topic, inquiriesMatched };
  }

  const deleted = await prisma.inquiry.deleteMany({ where: { storeId: store.id, email } });
  return { handled: true, topic, inquiriesDeleted: deleted.count };
}
