/**
 * Task 6A — pricing-coverage metrics + denormalized-state reconciliation.
 *
 * `reconcileCatalogCoverage` recomputes `CatalogProduct.assignedProfileId /
 * coverageStatus / enforcementReady / policySyncedAt` from the authoritative sources
 * (`ProductPricingOverride` + the pricing profile + `Store.shopCurrency`), in bounded
 * batches. Run it after a sync, after an assignment job, and after a rollback.
 *
 * `catalogCoverage` is a handful of `storeId`-scoped `count`s over the denormalized
 * columns — O(indexed rows), never a per-product loop.
 */

import type { PrismaClient } from "@prisma/client";
import { RECONCILE_BATCH_SIZE } from "./constants.ts";
import { loadOverridesByGid } from "./override-store.ts";
import { parseProductGid } from "./gid.ts";
import { resolveEnforceableCurrency } from "../pricing-api/currency-contract.ts";

export interface CatalogCoverage {
  totalProducts: number;
  assigned: number;
  unassigned: number;
  invalid: number;
  inactiveProfileAssignments: number;
  enforcementReady: number;
  removedFromShopify: number;
  lastSuccessfulSyncAt: Date | null;
  currentSyncStatus: string | null;
  activeBulkJobId: string | null;
  activeBulkJobStatus: string | null;
}

export async function catalogCoverage(prisma: PrismaClient, storeId: string): Promise<CatalogCoverage> {
  const live = { storeId, removedFromShopifyAt: null } as const;
  const [
    totalProducts,
    assigned,
    invalid,
    inactiveProfileAssignments,
    enforcementReady,
    removedFromShopify,
    lastSync,
    runningSync,
    activeBulk,
  ] = await Promise.all([
    prisma.catalogProduct.count({ where: live }),
    prisma.catalogProduct.count({ where: { ...live, coverageStatus: "assigned" } }),
    prisma.catalogProduct.count({ where: { ...live, coverageStatus: "invalid" } }),
    prisma.catalogProduct.count({ where: { ...live, coverageStatus: "inactive_profile" } }),
    prisma.catalogProduct.count({ where: { ...live, enforcementReady: true } }),
    prisma.catalogProduct.count({ where: { storeId, removedFromShopifyAt: { not: null } } }),
    prisma.catalogSyncJob.findFirst({
      where: { storeId, status: "completed" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    prisma.catalogSyncJob.findFirst({
      where: { storeId, status: { in: ["queued", "running"] } },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    }),
    prisma.bulkAssignmentJob.findFirst({
      where: { storeId, status: { in: ["queued", "running", "paused"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    }),
  ]);

  return {
    totalProducts,
    assigned,
    unassigned: totalProducts - assigned - invalid - inactiveProfileAssignments,
    invalid,
    inactiveProfileAssignments,
    enforcementReady,
    removedFromShopify,
    lastSuccessfulSyncAt: lastSync?.finishedAt ?? null,
    currentSyncStatus: runningSync?.status ?? null,
    activeBulkJobId: activeBulk?.id ?? null,
    activeBulkJobStatus: activeBulk?.status ?? null,
  };
}

export interface CoverageColumns {
  assignedProfileId: string | null;
  assignmentSource: string | null;
  coverageStatus: string;
  enforcementReady: boolean;
}

export interface CoverageChange {
  id: string;
  productGid: string;
  before: CoverageColumns;
  after: CoverageColumns;
}

export interface ReconcileOptions {
  /** Scope to these canonical product GIDs. An EMPTY list means "nothing to do", never "everything". */
  onlyProductIds?: string[];
  /** Compute and return the changes without writing anything. */
  dryRun?: boolean;
  /** Return the per-row changes (always returned for a dry run). */
  collectChanges?: boolean;
}

const UPDATE_CONCURRENCY = 10;

/**
 * Recomputes the denormalized coverage columns for a store's live catalog. Bounded:
 * processes `RECONCILE_BATCH_SIZE` products per pass, joins each to its override +
 * profile, and updates only rows whose derived state changed (a few at a time in
 * parallel, so a first-time reconcile of many linked products is not one round trip each).
 *
 * It never touches `policySyncedAt` or `policyDigest`, and `enforcementReady` is derived
 * (it stays false until a product's `policySyncedAt` is set by the assignment processor).
 */
export async function reconcileCatalogCoverage(
  prisma: PrismaClient,
  storeId: string,
  opts: ReconcileOptions = {},
): Promise<{ scanned: number; updated: number; changes?: CoverageChange[] }> {
  if (opts.onlyProductIds && opts.onlyProductIds.length === 0) return { scanned: 0, updated: 0, changes: [] };

  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { shopCurrency: true } });
  const shopCurrency = store?.shopCurrency ?? null;

  // profiles for this store, by id
  const profiles = await prisma.pricingProfile.findMany({
    where: { storeId },
    select: { id: true, isActive: true, currency: true },
  });
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  let scanned = 0;
  let updated = 0;
  let cursor: string | null = null;
  const changes: CoverageChange[] = [];

  interface CoverageRow {
    id: string;
    shopifyProductId: string;
    assignedProfileId: string | null;
    assignmentSource: string | null;
    policySyncedAt: Date | null;
    coverageStatus: string;
    enforcementReady: boolean;
  }

  for (;;) {
    const products: CoverageRow[] = await prisma.catalogProduct.findMany({
      where: {
        storeId,
        removedFromShopifyAt: null,
        ...(opts.onlyProductIds ? { shopifyProductId: { in: opts.onlyProductIds } } : {}),
      },
      orderBy: { id: "asc" },
      take: RECONCILE_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        shopifyProductId: true,
        assignedProfileId: true,
        assignmentSource: true,
        policySyncedAt: true,
        coverageStatus: true,
        enforcementReady: true,
      },
    });
    if (products.length === 0) break;

    const overrideByGid = await loadOverridesByGid(
      prisma,
      storeId,
      products.map((p) => p.shopifyProductId),
      { shopifyProductId: true, pricingProfileId: true, isActive: true },
    );

    const pending: CoverageChange[] = [];
    for (const p of products) {
      scanned += 1;
      const ov = overrideByGid.get(p.shopifyProductId);
      let assignedProfileId: string | null = null;
      let coverageStatus: string = "unassigned";
      let enforcementReady = false;

      if (ov && ov.isActive) {
        if (!ov.pricingProfileId) {
          coverageStatus = "invalid"; // active override that names no profile (or profile deleted → SetNull)
        } else {
          const prof = profileById.get(ov.pricingProfileId);
          if (!prof) {
            coverageStatus = "invalid"; // points at another store's / missing profile
          } else {
            assignedProfileId = prof.id;
            if (!prof.isActive) {
              coverageStatus = "inactive_profile";
            } else {
              coverageStatus = "assigned";
              // Task 6A.3B §3 — `enforcementReady` = the pricing profile + app-owned policy
              // metafield are in place (active profile, currency match, policy synced). It
              // is NOT a statement about whether checkout enforcement is switched on for
              // the shop — that is the separate `enforcement_policy.enabled` flag.
              const cur = resolveEnforceableCurrency(prof.currency, shopCurrency);
              enforcementReady = cur.ok && p.policySyncedAt != null;
            }
          }
        }
      }

      if (
        p.assignedProfileId !== assignedProfileId ||
        p.coverageStatus !== coverageStatus ||
        p.enforcementReady !== enforcementReady
      ) {
        pending.push({
          id: p.id,
          productGid: p.shopifyProductId,
          before: {
            assignedProfileId: p.assignedProfileId,
            assignmentSource: p.assignmentSource,
            coverageStatus: p.coverageStatus,
            enforcementReady: p.enforcementReady,
          },
          after: {
            assignedProfileId,
            coverageStatus,
            enforcementReady,
            assignmentSource: assignedProfileId ? (p.assignmentSource ?? "override") : null,
          },
        });
      }
    }

    if (!opts.dryRun) {
      for (let i = 0; i < pending.length; i += UPDATE_CONCURRENCY) {
        await Promise.all(
          pending.slice(i, i + UPDATE_CONCURRENCY).map((c) => prisma.catalogProduct.update({ where: { id: c.id }, data: c.after })),
        );
      }
    }
    updated += pending.length;
    if (opts.dryRun || opts.collectChanges) changes.push(...pending);

    if (products.length < RECONCILE_BATCH_SIZE) break;
    cursor = products[products.length - 1]!.id;
  }

  return opts.dryRun || opts.collectChanges ? { scanned, updated, changes } : { scanned, updated };
}

// ---------------------------------------------------------------------------------------
// Best-effort entry points used by the sync and the SKU-link paths
// ---------------------------------------------------------------------------------------

export interface BestEffortReconcile {
  ok: boolean;
  scanned: number;
  updated: number;
  error?: string;
}

const SCOPE_CHUNK = 1000;

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<url>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Recomputes coverage for exactly these products. Derived data must never fail the
 * operation that triggered it, so errors are returned, not thrown.
 */
export async function reconcileCoverageForProducts(prisma: PrismaClient, storeId: string, productGids: readonly string[]): Promise<BestEffortReconcile> {
  const gids = [...new Set(productGids.map((g) => parseProductGid(g)).filter((g): g is string => g !== null))];
  let scanned = 0;
  let updated = 0;
  try {
    for (let i = 0; i < gids.length; i += SCOPE_CHUNK) {
      const r = await reconcileCatalogCoverage(prisma, storeId, { onlyProductIds: gids.slice(i, i + SCOPE_CHUNK) });
      scanned += r.scanned;
      updated += r.updated;
    }
    return { ok: true, scanned, updated };
  } catch (error) {
    console.error("coverage reconcile failed (the triggering operation is unaffected):", safeMessage(error));
    return { ok: false, scanned, updated, error: safeMessage(error) };
  }
}

/**
 * Coverage after a catalog sync. A sync can insert products that already have an override
 * and can drop products an override used to cover, so the only rows whose derived state
 * can differ from the default are those with an override OR those currently marked as
 * covered. That is the scope, so the cost does not grow with the size of the catalog.
 */
export async function reconcileCoverageAfterSync(prisma: PrismaClient, storeId: string): Promise<BestEffortReconcile> {
  try {
    const [overrides, covered] = await Promise.all([
      prisma.productPricingOverride.findMany({ where: { storeId }, select: { shopifyProductId: true } }),
      prisma.catalogProduct.findMany({
        where: {
          storeId,
          OR: [{ coverageStatus: { not: "unassigned" } }, { assignedProfileId: { not: null } }, { enforcementReady: true }],
        },
        select: { shopifyProductId: true },
      }),
    ]);
    return await reconcileCoverageForProducts(prisma, storeId, [
      ...overrides.map((o) => o.shopifyProductId),
      ...covered.map((c) => c.shopifyProductId),
    ]);
  } catch (error) {
    console.error("coverage reconcile failed (the sync is unaffected):", safeMessage(error));
    return { ok: false, scanned: 0, updated: 0, error: safeMessage(error) };
  }
}
