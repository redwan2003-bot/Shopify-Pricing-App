/**
 * Task 6A — keep the local catalog in step with Shopify between full syncs, from the
 * `products/create`, `products/update`, `products/delete` webhooks.
 *
 * HMAC verification is done by `authenticate.webhook(request)` in the route BEFORE any
 * of this runs. Here we only ever:
 *   - dedupe the delivery by `X-Shopify-Webhook-Id`, scoped to the store
 *   - resolve the store from the AUTHENTICATED shop domain (never a payload field)
 *   - upsert / soft-remove the store's own `CatalogProduct` row, pricing-admin fields only
 *
 * A payload id is validated through `parseProductGid`; anything else is ignored (logged
 * without the payload body). No Shopify write ever happens from a webhook.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { parseProductGid, parseVariantGid } from "./gid.ts";
import { resolveStoreContext } from "./tenancy.ts";

export async function recordWebhookOnce(
  prisma: Pick<PrismaClient, "webhookEvent">,
  storeId: string,
  webhookId: string | null,
  topic: string,
  shopDomain: string,
): Promise<{ duplicate: boolean }> {
  if (!webhookId) return { duplicate: false }; // no id header → process (can't dedupe)
  try {
    await prisma.webhookEvent.create({ data: { storeId, webhookId, topic, shopDomain } });
    return { duplicate: false };
  } catch (error) {
    // unique [storeId, webhookId] violation → already processed
    if (isUniqueViolation(error)) return { duplicate: true };
    throw error;
  }
}

interface RestProductPayload {
  id?: unknown;
  admin_graphql_api_id?: unknown;
  title?: unknown;
  handle?: unknown;
  status?: unknown;
  vendor?: unknown;
  product_type?: unknown;
  tags?: unknown;
  updated_at?: unknown;
  variants?: unknown;
}

export interface WebhookSyncOutcome {
  applied: boolean;
  shopifyProductId: string | null;
  reason?: string;
}

/**
 * `products/create` + `products/update`: upsert the store's catalog row AND reconcile its
 * child variants (Task 6A.1), so exact SKU search stays correct between full syncs.
 *
 * The REST product payload carries the product's complete `variants` array, so it is
 * treated as authoritative: variants present are upserted, and variants this store has
 * for this product that are NOT in the payload are soft-removed.
 */
export async function applyProductUpsertWebhook(
  prisma: Pick<PrismaClient, "catalogProduct" | "catalogVariant">,
  storeId: string,
  payload: unknown,
  now: () => Date = () => new Date(),
): Promise<WebhookSyncOutcome> {
  const p = (payload ?? {}) as RestProductPayload;
  const gid = parseProductGid(p.admin_graphql_api_id ?? p.id);
  if (!gid) return { applied: false, shopifyProductId: null, reason: "no valid product id in payload" };

  const rawVariants = Array.isArray(p.variants) ? p.variants : [];
  const variants = rawVariants
    .map((raw, index) => normalizeWebhookVariant(raw, index))
    .filter((v): v is NormalizedWebhookVariant => v !== null);
  const hasAnySku = variants.some((v) => v.sku !== null);
  const at = now();

  const product = await prisma.catalogProduct.upsert({
    where: { storeId_shopifyProductId: { storeId, shopifyProductId: gid } },
    create: {
      storeId,
      shopifyProductId: gid,
      title: str(p.title) ?? "",
      handle: str(p.handle) ?? "",
      status: normalizeStatus(p.status),
      vendor: str(p.vendor),
      productType: str(p.product_type),
      tags: normalizeTags(p.tags),
      variantCount: rawVariants.length,
      hasAnySku,
      shopifyUpdatedAt: parseDate(p.updated_at),
      firstSeenAt: at,
      lastSeenAt: at,
      removedFromShopifyAt: null,
    },
    update: {
      title: str(p.title) ?? "",
      handle: str(p.handle) ?? "",
      status: normalizeStatus(p.status),
      vendor: str(p.vendor),
      productType: str(p.product_type),
      tags: normalizeTags(p.tags),
      variantCount: rawVariants.length,
      hasAnySku,
      shopifyUpdatedAt: parseDate(p.updated_at),
      lastSeenAt: at,
      removedFromShopifyAt: null,
    },
    select: { id: true },
  });

  await reconcileWebhookVariants(prisma, storeId, product.id, gid, variants, at);
  return { applied: true, shopifyProductId: gid };
}

/** `products/delete`: soft-remove the store's catalog row AND its variants (kept for
 * audit + rollback rather than hard-deleted). */
export async function applyProductDeleteWebhook(
  prisma: Pick<PrismaClient, "catalogProduct" | "catalogVariant">,
  storeId: string,
  payload: unknown,
  now: () => Date = () => new Date(),
): Promise<WebhookSyncOutcome> {
  const p = (payload ?? {}) as RestProductPayload;
  const gid = parseProductGid(p.admin_graphql_api_id ?? p.id);
  if (!gid) return { applied: false, shopifyProductId: null, reason: "no valid product id in payload" };

  const at = now();
  const res = await prisma.catalogProduct.updateMany({
    where: { storeId, shopifyProductId: gid, removedFromShopifyAt: null },
    data: { removedFromShopifyAt: at },
  });
  // Variants follow the product, store-scoped. Idempotent: already-removed rows are
  // excluded by the `removedFromShopifyAt: null` guard.
  await prisma.catalogVariant.updateMany({
    where: { storeId, shopifyProductId: gid, removedFromShopifyAt: null },
    data: { removedFromShopifyAt: at },
  });
  return { applied: res.count > 0, shopifyProductId: gid, reason: res.count === 0 ? "product not in local catalog" : undefined };
}

interface NormalizedWebhookVariant {
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  position: number;
  shopifyUpdatedAt: Date | null;
}

function normalizeWebhookVariant(raw: unknown, index: number): NormalizedWebhookVariant | null {
  const v = (raw ?? {}) as { id?: unknown; admin_graphql_api_id?: unknown; title?: unknown; sku?: unknown; updated_at?: unknown; position?: unknown };
  const gid = parseVariantGid(v.admin_graphql_api_id ?? v.id);
  if (!gid) return null;
  const sku = typeof v.sku === "string" ? v.sku.trim() : "";
  return {
    shopifyVariantId: gid,
    title: str(v.title) ?? "",
    sku: sku.length > 0 ? sku : null,
    position: typeof v.position === "number" ? v.position : index,
    shopifyUpdatedAt: parseDate(v.updated_at),
  };
}

/** Idempotent upsert + soft-removal of one product's variants, store-scoped. */
async function reconcileWebhookVariants(
  prisma: Pick<PrismaClient, "catalogVariant">,
  storeId: string,
  catalogProductId: string,
  shopifyProductId: string,
  variants: NormalizedWebhookVariant[],
  at: Date,
): Promise<void> {
  const incomingIds = variants.map((v) => v.shopifyVariantId);

  const existing = await prisma.catalogVariant.findMany({
    where: { storeId, shopifyProductId },
    select: { shopifyVariantId: true },
  });
  const existingIds = new Set(existing.map((e) => e.shopifyVariantId));

  const toCreate: Prisma.CatalogVariantCreateManyInput[] = [];
  for (const v of variants) {
    const row = {
      storeId,
      catalogProductId,
      shopifyVariantId: v.shopifyVariantId,
      shopifyProductId,
      title: v.title,
      sku: v.sku,
      position: v.position,
      shopifyUpdatedAt: v.shopifyUpdatedAt,
      removedFromShopifyAt: null,
    };
    if (existingIds.has(v.shopifyVariantId)) {
      await prisma.catalogVariant.update({
        where: { storeId_shopifyVariantId: { storeId, shopifyVariantId: v.shopifyVariantId } },
        data: row,
      });
    } else {
      toCreate.push(row);
    }
  }
  if (toCreate.length) await prisma.catalogVariant.createMany({ data: toCreate });

  // Variants this store had for this product that Shopify no longer reports.
  await prisma.catalogVariant.updateMany({
    where: {
      storeId,
      shopifyProductId,
      removedFromShopifyAt: null,
      ...(incomingIds.length ? { shopifyVariantId: { notIn: incomingIds } } : {}),
    },
    data: { removedFromShopifyAt: at },
  });
}

// ---------------------------------------------------------------------------
// Route-level orchestration
// ---------------------------------------------------------------------------

export interface AuthenticatedProductWebhook {
  /** the AUTHENTICATED shop domain from `authenticate.webhook` — never a payload field */
  shop: string;
  topic: string;
  webhookId: string | null;
  payload: unknown;
}

export type ProductWebhookResult =
  | { status: "processed"; topic: string; shopifyProductId: string | null }
  | { status: "duplicate"; topic: string }
  | { status: "ignored"; topic: string; reason: string };

/**
 * The full pipeline for a `products/{create,update,delete}` webhook once
 * `authenticate.webhook(request)` has verified HMAC + resolved the shop. Store is
 * resolved from `hook.shop`; the delivery is deduped by `webhookId`; the change is
 * applied only to that store's catalog. Never logs the payload body.
 */
export async function handleProductWebhookEvent(
  prisma: PrismaClient,
  hook: AuthenticatedProductWebhook,
): Promise<ProductWebhookResult> {
  const store = await resolveStoreContext(prisma, hook.shop, { createIfMissing: false });
  if (!store) return { status: "ignored", topic: hook.topic, reason: "no store for shop" };

  const dedupe = await recordWebhookOnce(prisma, store.storeId, hook.webhookId, hook.topic, hook.shop);
  if (dedupe.duplicate) return { status: "duplicate", topic: hook.topic };

  const normalized = hook.topic.toUpperCase().replace(/\//g, "_"); // PRODUCTS_CREATE etc.
  if (normalized === "PRODUCTS_DELETE") {
    const r = await applyProductDeleteWebhook(prisma, store.storeId, hook.payload);
    return { status: "processed", topic: hook.topic, shopifyProductId: r.shopifyProductId };
  }
  if (normalized === "PRODUCTS_CREATE" || normalized === "PRODUCTS_UPDATE") {
    const r = await applyProductUpsertWebhook(prisma, store.storeId, hook.payload);
    return { status: "processed", topic: hook.topic, shopifyProductId: r.shopifyProductId };
  }
  return { status: "ignored", topic: hook.topic, reason: "unhandled topic" };
}

// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function normalizeStatus(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s === "ACTIVE" || s === "ARCHIVED" || s === "DRAFT" ? s : "ACTIVE";
}
function normalizeTags(v: unknown): string {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return arr
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean)
    .join(",");
}
function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
