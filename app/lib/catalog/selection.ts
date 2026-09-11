/**
 * Task 6A — server-side bulk-selection descriptors.
 *
 * The browser NEVER sends thousands of product ids. A selection is one of:
 *   { kind: "ids",    ids: [...] }          — an explicit, bounded list (≤ SELECTION_INLINE_MAX)
 *   { kind: "filter", filter: {...} }       — "all filtered results"
 *   { kind: "all" }                         — "all eligible products"
 *
 * The server re-resolves a `filter`/`all` descriptor against the current catalog each
 * time it needs the target set (dry-run count, per-batch id fetch), and every resolved
 * id is confirmed to have a `CatalogProduct` row for THIS store. `all` = the store's
 * live, non-removed catalog.
 */

import type { PrismaClient } from "@prisma/client";
import { RECONCILE_BATCH_SIZE, SELECTION_INLINE_MAX } from "./constants.ts";
import { buildCatalogWhere, type CatalogFilter } from "./catalog-query.ts";
import { normalizeProductGidList } from "./gid.ts";

export type SelectionDescriptor =
  | { kind: "ids"; ids: string[] }
  | { kind: "filter"; filter: CatalogFilter }
  | { kind: "all" };

export class SelectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SelectionError";
    this.code = code;
  }
}

/**
 * The `CatalogFilter` fields that actually NARROW the result set. `skuMatch` is only a
 * match modifier and `includeRemoved` only widens, so neither counts as narrowing.
 */
const NARROWING_FILTER_KEYS = [
  "text",
  "productId",
  "sku",
  "coverageStatus",
  "pricingProfileId",
  "shopifyStatus",
  "vendor",
  "productType",
  "tag",
] as const satisfies ReadonlyArray<keyof CatalogFilter>;

/** True when `filter` restricts the catalog to fewer than all products. */
export function filterNarrowsSelection(filter: CatalogFilter): boolean {
  return NARROWING_FILTER_KEYS.some((key) => {
    const value = filter[key];
    return typeof value === "string" ? value.trim() !== "" : value != null;
  });
}

/**
 * True when a descriptor would touch EVERY product in the store's catalog: `kind: "all"`,
 * or a `kind: "filter"` whose filter sets no narrowing field. An accidental one-click
 * "assign a profile to the whole catalog" is what this gates — the Catalog Admin route
 * requires an explicit acknowledgement, and `handleCatalogAdminAction` refuses a `dryRun`
 * for a whole-catalog selection unless `acknowledgeWholeCatalog` is sent. An explicit
 * `kind: "ids"` list is always bounded and never whole-catalog.
 */
export function selectionTargetsWholeCatalog(selection: SelectionDescriptor): boolean {
  if (selection.kind === "all") return true;
  if (selection.kind === "filter") return !filterNarrowsSelection(selection.filter);
  return false;
}

/** Validates + canonicalizes a raw descriptor from a request. Throws `SelectionError`
 * on anything malformed or over the inline cap. */
export function parseSelectionDescriptor(raw: unknown): SelectionDescriptor {
  if (!raw || typeof raw !== "object") throw new SelectionError("MALFORMED", "selection is not an object");
  const r = raw as Record<string, unknown>;
  if (r.kind === "ids") {
    if (!Array.isArray(r.ids)) throw new SelectionError("MALFORMED", "selection.ids is not an array");
    if (r.ids.length === 0) throw new SelectionError("EMPTY", "selection.ids is empty");
    if (r.ids.length > SELECTION_INLINE_MAX) {
      throw new SelectionError("TOO_MANY_IDS", `an explicit selection is capped at ${SELECTION_INLINE_MAX} ids — use a filter selection`);
    }
    const { gids, invalid } = normalizeProductGidList(r.ids);
    if (invalid.length) throw new SelectionError("MALFORMED_ID", `${invalid.length} product id(s) are not valid product GIDs`);
    return { kind: "ids", ids: gids };
  }
  if (r.kind === "filter") {
    if (!r.filter || typeof r.filter !== "object") throw new SelectionError("MALFORMED", "selection.filter is not an object");
    return { kind: "filter", filter: sanitizeFilter(r.filter as Record<string, unknown>) };
  }
  if (r.kind === "all") return { kind: "all" };
  throw new SelectionError("MALFORMED", `unknown selection kind: ${JSON.stringify(r.kind)}`);
}

function sanitizeFilter(f: Record<string, unknown>): CatalogFilter {
  const s = (v: unknown) => (typeof v === "string" && v.length <= 256 ? v : undefined);
  return {
    text: s(f.text),
    productId: s(f.productId),
    sku: s(f.sku),
    skuMatch: f.skuMatch === "contains" ? "contains" : f.skuMatch === "exact" ? "exact" : undefined,
    coverageStatus: (["unassigned", "assigned", "inactive_profile", "invalid"] as const).includes(f.coverageStatus as never)
      ? (f.coverageStatus as CatalogFilter["coverageStatus"])
      : undefined,
    pricingProfileId: s(f.pricingProfileId),
    shopifyStatus: s(f.shopifyStatus),
    vendor: s(f.vendor),
    productType: s(f.productType),
    tag: s(f.tag),
    // `all`/`filter` selections never target removed products
    includeRemoved: false,
  };
}

/** A stable hash of a descriptor, for the dry-run fingerprint. Order-independent for
 * `ids`, key-sorted for `filter`. */
export function hashSelection(sel: SelectionDescriptor): string {
  if (sel.kind === "ids") return `ids:${[...sel.ids].sort().join(",")}`;
  if (sel.kind === "all") return "all";
  const f = sel.filter;
  const keys = Object.keys(f).sort() as Array<keyof CatalogFilter>;
  return `filter:${keys.map((k) => `${k}=${String(f[k] ?? "")}`).join("&")}`;
}

// ---------------------------------------------------------------------------
// Resolution against the live, store-scoped catalog
// ---------------------------------------------------------------------------

/** Count of catalog products the selection currently resolves to — bounded query. */
export async function countSelection(
  prisma: Pick<PrismaClient, "catalogProduct">,
  storeId: string,
  sel: SelectionDescriptor,
): Promise<number> {
  if (sel.kind === "ids") {
    return prisma.catalogProduct.count({
      where: { storeId, removedFromShopifyAt: null, shopifyProductId: { in: sel.ids } },
    });
  }
  const where = sel.kind === "all" ? { storeId, removedFromShopifyAt: null } : buildCatalogWhere(storeId, sel.filter);
  return prisma.catalogProduct.count({ where });
}

/** Streams the resolved catalog-product rows in batches — the processor's per-batch
 * source of truth. Every row is `storeId`-scoped and non-removed. */
export async function* iterateSelection(
  prisma: Pick<PrismaClient, "catalogProduct">,
  storeId: string,
  sel: SelectionDescriptor,
  batchSize = RECONCILE_BATCH_SIZE,
): AsyncGenerator<Array<{ id: string; shopifyProductId: string }>> {
  const where =
    sel.kind === "ids"
      ? { storeId, removedFromShopifyAt: null, shopifyProductId: { in: sel.ids } }
      : sel.kind === "all"
        ? { storeId, removedFromShopifyAt: null }
        : buildCatalogWhere(storeId, sel.filter);

  let cursor: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; shopifyProductId: string }> = await prisma.catalogProduct.findMany({
      where,
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, shopifyProductId: true },
    });
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < batchSize) return;
    cursor = rows[rows.length - 1]!.id;
  }
}
