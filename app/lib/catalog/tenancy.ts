/**
 * Task 6A — the single tenancy gate for catalog management.
 *
 * The store id is ALWAYS derived here from the authenticated session's shop domain
 * (`authenticate.admin(request).session.shop`) — never from a request body, query
 * param, or webhook payload field. Every catalog / job / assignment query in
 * `app/lib/catalog/*` is scoped by the `storeId` this returns, and every product id
 * that enters an assignment is confirmed to have a `CatalogProduct` row for THIS store
 * before it is acted on. There is no code path that reads or writes another shop's
 * catalog, profile, job, item or audit record.
 */

import type { PrismaClient } from "@prisma/client";
import { parseProductGid } from "./gid.ts";

export class CrossTenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossTenantError";
  }
}

export interface StoreContext {
  storeId: string;
  shopDomain: string;
  shopCurrency: string | null;
}

/**
 * Resolves the `Store` for an authenticated shop domain. `createIfMissing` upserts —
 * used by loaders that must show a first-run empty state without a prior write
 * elsewhere. Callers pass `session.shop` verbatim; this function never accepts a domain
 * from anywhere else.
 */
export async function resolveStoreContext(
  prisma: Pick<PrismaClient, "store">,
  shopDomain: string,
  opts: { createIfMissing?: boolean } = {},
): Promise<StoreContext | null> {
  if (typeof shopDomain !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain)) {
    throw new CrossTenantError("shop domain is not a valid *.myshopify.com host");
  }
  const store = opts.createIfMissing
    ? await prisma.store.upsert({ where: { shopDomain }, update: {}, create: { shopDomain } })
    : await prisma.store.findUnique({ where: { shopDomain } });
  if (!store) return null;
  return { storeId: store.id, shopDomain: store.shopDomain, shopCurrency: store.shopCurrency ?? null };
}

/**
 * Confirms every requested product GID has a `CatalogProduct` row for THIS store, is
 * not marked removed-from-Shopify, and returns the matched catalog rows. Any id that is
 * malformed, unknown, removed, or (impossible via the unique index, but checked anyway)
 * belongs to another store is reported in `rejected` — the caller fails the operation,
 * never silently drops it.
 */
export async function resolveStoreProducts(
  prisma: Pick<PrismaClient, "catalogProduct">,
  storeId: string,
  productGids: readonly string[],
): Promise<{
  matched: Array<{ id: string; shopifyProductId: string }>;
  rejected: Array<{ value: string; reason: "malformed" | "unknown" | "removed" }>;
}> {
  const rejected: Array<{ value: string; reason: "malformed" | "unknown" | "removed" }> = [];
  const canonical: string[] = [];
  for (const raw of productGids) {
    const gid = parseProductGid(raw);
    if (gid === null) rejected.push({ value: String(raw), reason: "malformed" });
    else canonical.push(gid);
  }

  if (canonical.length === 0) return { matched: [], rejected };

  const rows = await prisma.catalogProduct.findMany({
    where: { storeId, shopifyProductId: { in: canonical } },
    select: { id: true, shopifyProductId: true, removedFromShopifyAt: true },
  });
  const byGid = new Map(rows.map((r) => [r.shopifyProductId, r]));

  const matched: Array<{ id: string; shopifyProductId: string }> = [];
  for (const gid of canonical) {
    const row = byGid.get(gid);
    if (!row) rejected.push({ value: gid, reason: "unknown" });
    else if (row.removedFromShopifyAt) rejected.push({ value: gid, reason: "removed" });
    else matched.push({ id: row.id, shopifyProductId: row.shopifyProductId });
  }
  return { matched, rejected };
}
