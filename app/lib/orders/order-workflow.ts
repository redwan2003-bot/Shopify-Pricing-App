export const ORDER_WORKFLOW_STATUSES = [
  "received",
  "artwork_pending",
  "proof_ready",
  "revision_requested",
  "approved",
  "production",
  "shipped",
  "completed",
] as const;

type Property = { name?: unknown; value?: unknown };

export interface NormalizedOrderConfiguration {
  shopifyLineItemId: string;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  sku: string | null;
  quantity: number;
  configuration: string | null;
  pricingPayload: string | null;
  pricingSignature: string | null;
  pricingVersion: number | null;
  configDigest: string | null;
  quoteEnvelopePresent: boolean;
}

export interface NormalizedOrderWorkflow {
  shopifyOrderId: string;
  orderNumber: string | null;
  currency: string | null;
  configurations: NormalizedOrderConfiguration[];
}

type OrderWorkflowPrisma = {
  store: {
    findUnique(args: { where: { shopDomain: string }; select: { id: true } }): Promise<{ id: string } | null>;
  };
  orderWorkflow: {
    upsert(args: Record<string, unknown>): Promise<{ id: string }>;
    update(args: Record<string, unknown>): Promise<unknown>;
  };
};

function stringValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function propertyMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value as Property[]) {
      const name = stringValue(item?.name);
      const propertyValue = stringValue(item?.value);
      if (name && propertyValue) map.set(name, propertyValue);
    }
  } else if (value && typeof value === "object") {
    for (const [name, propertyValue] of Object.entries(value)) {
      const normalized = stringValue(propertyValue);
      if (normalized) map.set(name, normalized);
    }
  }
  return map;
}

function validJson(value: string | null): string | null {
  if (!value || value.length > 8192) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? value : null;
  } catch {
    return null;
  }
}

export function normalizeOrderWorkflow(payload: unknown): NormalizedOrderWorkflow | null {
  const order = (payload ?? {}) as Record<string, unknown>;
  const shopifyOrderId = stringValue(order.admin_graphql_api_id ?? order.id);
  if (!shopifyOrderId) return null;

  const rawItems = Array.isArray(order.line_items) ? order.line_items : [];
  const configurations: NormalizedOrderConfiguration[] = [];
  for (const rawItem of rawItems) {
    const item = (rawItem ?? {}) as Record<string, unknown>;
    const lineId = stringValue(item.admin_graphql_api_id ?? item.id);
    const quantity = typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 0;
    if (!lineId || !quantity) continue;
    const props = propertyMap(item.properties);
    const pricingPayload = stringValue(props.get("_imprintid_pricing_payload"));
    const pricingSignature = stringValue(props.get("_imprintid_pricing_signature"));
    const configuration = validJson(stringValue(props.get("_imprintid_pricing_config")));
    const pricingVersionRaw = Number(props.get("_imprintid_pricing_version"));
    const pricingVersion = Number.isInteger(pricingVersionRaw) ? pricingVersionRaw : null;
    const payloadJson = validJson(pricingPayload);
    let configDigest: string | null = null;
    if (payloadJson) {
      try {
        const parsed = JSON.parse(payloadJson) as { configDigest?: unknown };
        configDigest = stringValue(parsed.configDigest);
      } catch {
        // validJson already checked this; keep the persistence path defensive.
      }
    }
    configurations.push({
      shopifyLineItemId: lineId,
      shopifyProductId: stringValue(item.admin_graphql_api_id_product ?? item.product_id),
      shopifyVariantId: stringValue(item.variant_admin_graphql_api_id ?? item.variant_id),
      sku: stringValue(item.sku),
      quantity,
      configuration,
      pricingPayload,
      pricingSignature,
      pricingVersion,
      configDigest,
      quoteEnvelopePresent: pricingVersion === 2 && Boolean(payloadJson && pricingSignature && configuration),
    });
  }

  return {
    shopifyOrderId,
    orderNumber: stringValue(order.name ?? order.order_number),
    currency: stringValue(order.currency ?? order.presentment_currency),
    configurations,
  };
}

export async function persistOrderWorkflow(prisma: OrderWorkflowPrisma, shopDomain: string, payload: unknown) {
  const normalized = normalizeOrderWorkflow(payload);
  if (!normalized) return { ok: false as const, reason: "invalid_order" };
  const store = await prisma.store.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!store) return { ok: false as const, reason: "store_not_found" };

  const signedCount = normalized.configurations.filter((item) => item.quoteEnvelopePresent).length;
  const workflow = await prisma.orderWorkflow.upsert({
    where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: normalized.shopifyOrderId } },
    create: {
      storeId: store.id,
      shopifyOrderId: normalized.shopifyOrderId,
      orderNumber: normalized.orderNumber,
      currency: normalized.currency,
      status: "received",
    },
    update: { orderNumber: normalized.orderNumber, currency: normalized.currency },
    select: { id: true },
  });

  for (const item of normalized.configurations) {
    await prisma.orderWorkflow.update({
      where: { id: workflow.id },
      data: {
        configurations: {
          upsert: {
            where: { workflowId_shopifyLineItemId: { workflowId: workflow.id, shopifyLineItemId: item.shopifyLineItemId } },
            create: item,
            update: item,
          },
        },
      },
    });
  }
  return { ok: true as const, workflowId: workflow.id, configurationCount: normalized.configurations.length, signedCount };
}
