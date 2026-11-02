import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { reconcileCatalogCoverage, type CoverageChange, type CoverageColumns } from "./coverage.ts";

/**
 * Plan / apply / rollback for a one-off coverage reconciliation of a whole store.
 *
 *  plan      a dry run of the reconcile: the exact rows and columns that would change.
 *            Writes nothing.
 *  apply     refuses unless the freshly rebuilt plan hashes to the plan a human approved.
 *            Writes a manifest (every row's before-values) BEFORE the first update, then writes
 *            exactly the planned values, each guarded by "only if the row still has its planned
 *            before-values". A row that changed in the meantime is a conflict and stops the run.
 *  rollback  restores the before-values, only for rows still holding the values this run wrote.
 *
 * Only these derived columns are ever written: assignedProfileId, assignmentSource,
 * coverageStatus, enforcementReady. `policySyncedAt` and `policyDigest` are never touched, and
 * the contract check refuses any plan that would turn enforcementReady on.
 */

export interface CoveragePlan {
  shop: string;
  storeId: string;
  scanned: number;
  changes: CoverageChange[];
  totals: {
    changes: number;
    byTransition: Record<string, number>;
    enforcementReadyChanges: number;
    withoutProfile: number;
  };
  hash: string;
}

export interface CoverageContract {
  changes: number;
  /** the only transition the plan may contain, e.g. "unassigned->assigned" */
  transition: string;
}

export type CoverageEntryStatus = "planned" | "done" | "conflict" | "skipped";

export interface CoverageManifest {
  version: 1;
  kind: "coverage-reconcile";
  createdAt: string;
  shop: string;
  storeId: string;
  planHash: string;
  state: "planned" | "applying" | "completed" | "aborted" | "rolled_back";
  abortedBecause?: string[];
  entries: (CoverageChange & { status: CoverageEntryStatus; rolledBack?: string })[];
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
}

const transitionOf = (c: CoverageChange) => `${c.before.coverageStatus}->${c.after.coverageStatus}`;

export async function buildCoveragePlan(prisma: PrismaClient, storeId: string, shop: string): Promise<CoveragePlan> {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { shopDomain: true } });
  if (!store || store.shopDomain !== shop) throw new Error("the store id does not belong to the confirmed shop");

  const result = await reconcileCatalogCoverage(prisma, storeId, { dryRun: true });
  const changes = [...(result.changes ?? [])].sort((a, b) => (a.productGid < b.productGid ? -1 : a.productGid > b.productGid ? 1 : 0));
  const byTransition: Record<string, number> = {};
  for (const c of changes) byTransition[transitionOf(c)] = (byTransition[transitionOf(c)] ?? 0) + 1;
  const hash = createHash("sha256")
    .update(stable({ shop, storeId, changes: changes.map((c) => ({ id: c.id, productGid: c.productGid, before: c.before, after: c.after })) }))
    .digest("hex");
  return {
    shop,
    storeId,
    scanned: result.scanned,
    changes,
    totals: {
      changes: changes.length,
      byTransition,
      enforcementReadyChanges: changes.filter((c) => c.before.enforcementReady !== c.after.enforcementReady).length,
      withoutProfile: changes.filter((c) => c.after.coverageStatus === "assigned" && !c.after.assignedProfileId).length,
    },
    hash,
  };
}

export function checkCoverageContract(plan: CoveragePlan, contract: CoverageContract): string[] {
  const problems: string[] = [];
  if (plan.totals.changes !== contract.changes) problems.push(`changes: expected ${contract.changes}, got ${plan.totals.changes}`);
  for (const [transition, n] of Object.entries(plan.totals.byTransition)) {
    if (transition !== contract.transition) problems.push(`${n} change(s) of kind ${transition}, but only ${contract.transition} is allowed`);
  }
  if (plan.totals.enforcementReadyChanges > 0) problems.push(`${plan.totals.enforcementReadyChanges} change(s) would alter enforcementReady, which this run must not do`);
  if (plan.totals.withoutProfile > 0) problems.push(`${plan.totals.withoutProfile} 'assigned' row(s) without a profile`);
  return problems;
}

const WRITE_BATCH = 25;

const sameColumns = (a: CoverageColumns): CoverageColumns => ({
  assignedProfileId: a.assignedProfileId,
  assignmentSource: a.assignmentSource,
  coverageStatus: a.coverageStatus,
  enforcementReady: a.enforcementReady,
});

export async function applyCoveragePlan(deps: {
  prisma: PrismaClient;
  storeId: string;
  shop: string;
  approvedHash: string;
  onManifest: (m: CoverageManifest) => Promise<void>;
  now?: () => Date;
}): Promise<{ state: CoverageManifest["state"]; refusedBecause?: string[]; abortedBecause?: string[]; updated: number; manifest?: CoverageManifest }> {
  const plan = await buildCoveragePlan(deps.prisma, deps.storeId, deps.shop);
  if (plan.hash !== deps.approvedHash) {
    return { state: "aborted", refusedBecause: ["the live plan no longer matches the approved plan (hash differs); re-run plan mode and review again"], updated: 0 };
  }

  const manifest: CoverageManifest = {
    version: 1,
    kind: "coverage-reconcile",
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    shop: deps.shop,
    storeId: deps.storeId,
    planHash: plan.hash,
    state: "planned",
    entries: plan.changes.map((c) => ({ ...c, status: "planned" as CoverageEntryStatus })),
  };
  await deps.onManifest(manifest); // BEFORE the first update: the audit and rollback record
  manifest.state = "applying";

  let updated = 0;
  for (let i = 0; i < manifest.entries.length; i += WRITE_BATCH) {
    const batch = manifest.entries.slice(i, i + WRITE_BATCH);
    const results = await Promise.all(
      batch.map((e) =>
        deps.prisma.catalogProduct.updateMany({
          // compare-and-set: only if the row still has exactly the values the plan was built from
          where: { id: e.id, storeId: deps.storeId, ...sameColumns(e.before) },
          data: sameColumns(e.after),
        }),
      ),
    );
    const conflicts: string[] = [];
    batch.forEach((e, k) => {
      if (results[k].count === 1) {
        e.status = "done";
        updated += 1;
      } else {
        e.status = "conflict";
        conflicts.push(`${e.productGid}: the row changed since the plan; not overwritten`);
      }
    });
    await deps.onManifest(manifest);
    if (conflicts.length) {
      manifest.state = "aborted";
      manifest.abortedBecause = conflicts;
      for (const e of manifest.entries) if (e.status === "planned") e.status = "skipped";
      await deps.onManifest(manifest);
      return { state: "aborted", abortedBecause: conflicts, updated, manifest };
    }
  }

  manifest.state = "completed";
  await deps.onManifest(manifest);
  return { state: "completed", updated, manifest };
}

export async function rollbackCoveragePlan(deps: {
  prisma: PrismaClient;
  storeId: string;
  shop: string;
  manifest: CoverageManifest;
  onManifest: (m: CoverageManifest) => Promise<void>;
}): Promise<{ restored: number; skipped: string[] }> {
  const { manifest } = deps;
  if (manifest.shop !== deps.shop || manifest.storeId !== deps.storeId) throw new Error("the manifest belongs to a different shop or store");
  let restored = 0;
  const skipped: string[] = [];
  for (const e of manifest.entries) {
    if (e.status !== "done") continue;
    const res = await deps.prisma.catalogProduct.updateMany({
      where: { id: e.id, storeId: deps.storeId, ...sameColumns(e.after) },
      data: sameColumns(e.before),
    });
    if (res.count === 1) {
      e.rolledBack = "restored";
      restored += 1;
    } else {
      e.rolledBack = "skipped: the row changed after this run wrote it";
      skipped.push(`${e.productGid}: the row changed after this run; left alone`);
    }
  }
  manifest.state = "rolled_back";
  await deps.onManifest(manifest);
  return { restored, skipped };
}
