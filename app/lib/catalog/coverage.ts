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

/**
 * Recomputes the denormalized coverage columns for a store's live catalog. Bounded:
 * processes `RECONCILE_BATCH_SIZE` products per pass, joins each to its override +
 * profile, and updates only rows whose derived state changed.
 */
export async function reconcileCatalogCoverage(
  prisma: PrismaClient,
  storeId: string,
  opts: { onlyProductIds?: string[] } = {},
): Promise<{ scanned: number; updated: number }> {
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
        ...(opts.onlyProductIds?.length ? { shopifyProductId: { in: opts.onlyProductIds } } : {}),
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
        await prisma.catalogProduct.update({
          where: { id: p.id },
          data: {
            assignedProfileId,
            coverageStatus,
            enforcementReady,
            assignmentSource: assignedProfileId ? (p.assignmentSource ?? "override") : null,
          },
        });
        updated += 1;
      }
    }

    if (products.length < RECONCILE_BATCH_SIZE) break;
    cursor = products[products.length - 1]!.id;
  }

  return { scanned, updated };
}
