/**
 * Task 6A / 6A.1 — the Catalog Management page's loader data and its ACTION DISPATCHER.
 *
 * Every long-running operation is driven end to end through this dispatcher as a series
 * of BOUNDED authenticated requests. There are no detached promises and no in-memory
 * worker: each action does a bounded amount of work, persists its progress, and reports
 * whether the caller should call again (`more: true`). Closing or refreshing the browser
 * loses nothing — the job rows carry the whole state, and the next request resumes from
 * the persisted checkpoint.
 *
 *   sync.start    → creates the job AND starts the Shopify bulk operation  (never "done")
 *   sync.advance  → polls the OWNED bulk operation, or ingests one bounded JSONL chunk
 *   dryRun        → plans, fingerprints, persists evidence
 *   apply         → re-verifies the evidence and materializes items       (never "done")
 *   job.process   → runs bounded assignment batches through the real write port
 *   job.retry     → re-queues retryable failed items
 *   job.resume    → releases an expired lease so an interrupted job continues
 *   rollback.plan → materializes a rollback job from the stored snapshots
 *   rollback.process → runs bounded rollback batches
 *
 * The store id is ALWAYS the one resolved from the authenticated session's shop domain;
 * nothing here accepts a store, shop or job that the session does not own.
 */

import type { PrismaClient } from "@prisma/client";
import { ASSIGN_BATCHES_PER_REQUEST, PAGE_SIZE, SYNC_OBJECTS_PER_REQUEST } from "./constants.ts";
import { catalogCoverage, type CatalogCoverage } from "./coverage.ts";
import { catalogFacets, queryCatalogPage, type CatalogFilter, type CatalogPage } from "./catalog-query.ts";
import { advanceCatalogSync, startCatalogSync, type AdvanceSyncDeps } from "./catalog-sync.ts";
import { planBulkAssignment } from "./dry-run.ts";
import { confirmAndCreateJob } from "./apply.ts";
import { planRollback, processRollbackJob } from "./rollback.ts";
import { processAssignmentJob, requeueFailedItems, resumeInterruptedJob } from "./processor.ts";
import { parseSelectionDescriptor, selectionTargetsWholeCatalog, SelectionError, type SelectionDescriptor } from "./selection.ts";
import { createAdminWritePort } from "./write-port.ts";
import type { AdminGraphqlClientLike, ShopPolicyContext } from "./admin-client.ts";
import type { StoreContext } from "./tenancy.ts";
import { applyLinkReport, buildLinkReport } from "../pricing-import/link-products.ts";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface SyncJobView {
  id: string;
  status: string;
  bulkOperationStatus: string | null;
  objectsSeen: number;
  productsUpserted: number;
  productsRemoved: number;
  variantsUpserted: number;
  variantsRemoved: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** true while the UI should keep calling `sync.advance` */
  active: boolean;
}

export interface BulkJobView {
  id: string;
  jobType: string;
  status: string;
  pricingProfileId: string | null;
  totalItems: number;
  /** assign: products written. rollback: products actually restored (a wrote-back
   * change) — Task 6A.3B §2, NOT items that were already at the previous state. */
  succeeded: number;
  /** assign: already at the target + policy synced. rollback: already at the previous
   * state, so the rollback performed zero writes for them. */
  unchanged: number;
  skipped: number;
  failed: number;
  conflicts: number;
  retryableFailed: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  rollbackOfJobId: string | null;
  hasRollback: boolean;
  /** true while the UI should keep calling `job.process` / `rollback.process` */
  active: boolean;
  /** a live lease means another request is mid-batch right now */
  leaseHeld: boolean;
}

export interface CatalogAdminData {
  coverage: CatalogCoverage;
  page: CatalogPage;
  filter: CatalogFilter;
  facets: { vendors: string[]; productTypes: string[] };
  profiles: Array<{ id: string; name: string; currency: string; isActive: boolean; revision: number }>;
  syncJobs: SyncJobView[];
  bulkJobs: BulkJobView[];
  /** any active sync/assignment/rollback — conflicting actions are disabled while set */
  activeSyncJobId: string | null;
  activeBulkJobId: string | null;
  variantCount: number;
}

export function parseCatalogFilter(params: URLSearchParams): CatalogFilter {
  const s = (k: string) => {
    const v = params.get(k);
    return v && v.trim() ? v.trim().slice(0, 256) : undefined;
  };
  const coverage = s("coverageStatus");
  const skuMatch = s("skuMatch");
  return {
    text: s("text"),
    productId: s("productId"),
    sku: s("sku"),
    skuMatch: skuMatch === "contains" ? "contains" : "exact",
    coverageStatus: (["unassigned", "assigned", "inactive_profile", "invalid"] as const).includes(coverage as never)
      ? (coverage as CatalogFilter["coverageStatus"])
      : undefined,
    pricingProfileId: s("pricingProfileId"),
    shopifyStatus: s("shopifyStatus"),
    vendor: s("vendor"),
    productType: s("productType"),
    tag: s("tag"),
    includeRemoved: params.get("includeRemoved") === "1",
  };
}

const ACTIVE_SYNC = ["queued", "awaiting_bulk", "ingesting", "running"];
const ACTIVE_BULK = ["queued", "materializing", "running", "paused"];

export async function loadCatalogAdmin(
  prisma: PrismaClient,
  store: StoreContext,
  params: URLSearchParams,
  now: Date = new Date(),
): Promise<CatalogAdminData> {
  const filter = parseCatalogFilter(params);
  const cursor = params.get("cursor");
  const pageSize = clampPageSize(params.get("pageSize"));
  const storeId = store.storeId;

  const [coverage, page, facets, profiles, syncRows, bulkRows, variantCount] = await Promise.all([
    catalogCoverage(prisma, storeId),
    queryCatalogPage(prisma, storeId, filter, { cursor, pageSize }),
    catalogFacets(prisma, storeId),
    prisma.pricingProfile.findMany({
      where: { storeId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true, isActive: true, revision: true },
    }),
    prisma.catalogSyncJob.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.bulkAssignmentJob.findMany({
      where: { storeId, status: { not: "dry_run" } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.catalogVariant.count({ where: { storeId, removedFromShopifyAt: null } }),
  ]);

  // Per-job failure breakdown, in one grouped query rather than per row.
  const failedByJob = bulkRows.length
    ? await prisma.bulkAssignmentItem.groupBy({
        by: ["jobId", "errorCode"],
        where: { storeId, jobId: { in: bulkRows.map((j) => j.id) }, status: "failed" },
        _count: { _all: true },
      })
    : [];
  const rollbackTargets = new Set(bulkRows.map((j) => j.rollbackOfJobId).filter((v): v is string => !!v));

  const syncJobs: SyncJobView[] = syncRows.map((j) => ({
    id: j.id,
    status: j.status,
    bulkOperationStatus: j.bulkOperationStatus,
    objectsSeen: j.objectsSeen,
    productsUpserted: j.productsUpserted,
    productsRemoved: j.productsRemoved,
    variantsUpserted: j.variantsUpserted,
    variantsRemoved: j.variantsRemoved,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    errorCode: j.errorCode,
    errorMessage: j.errorMessage,
    active: ACTIVE_SYNC.includes(j.status),
  }));

  const bulkJobs: BulkJobView[] = bulkRows.map((j) => {
    const rows = failedByJob.filter((f) => f.jobId === j.id);
    const conflicts = rows
      .filter((r) => r.errorCode === "PERMANENT_POLICY_CONFLICT" || r.errorCode === "PERMANENT_ROLLBACK_CONFLICT")
      .reduce((n, r) => n + r._count._all, 0);
    const retryableFailed = rows
      .filter((r) => !r.errorCode || !r.errorCode.startsWith("PERMANENT_"))
      .reduce((n, r) => n + r._count._all, 0);
    return {
      id: j.id,
      jobType: j.jobType,
      status: j.status,
      pricingProfileId: j.pricingProfileId,
      totalItems: j.totalItems,
      succeeded: j.succeeded,
      unchanged: j.unchanged,
      skipped: j.skipped,
      failed: j.failed,
      conflicts,
      retryableFailed,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      errorCode: j.errorCode,
      errorMessage: j.errorMessage,
      rollbackOfJobId: j.rollbackOfJobId,
      hasRollback: rollbackTargets.has(j.id),
      active: ACTIVE_BULK.includes(j.status),
      leaseHeld: !!j.workerToken && !!j.leaseExpiresAt && j.leaseExpiresAt > now,
    };
  });

  return {
    coverage,
    page,
    filter,
    facets,
    profiles,
    syncJobs,
    bulkJobs,
    activeSyncJobId: syncJobs.find((j) => j.active)?.id ?? null,
    activeBulkJobId: bulkJobs.find((j) => j.active)?.id ?? null,
    variantCount,
  };
}

function clampPageSize(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : PAGE_SIZE;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type CatalogActionResult =
  | {
      ok: true;
      intent: string;
      message: string;
      /** true when the client must call the SAME intent again to make progress */
      more: boolean;
      data?: Record<string, unknown>;
    }
  | { ok: false; intent: string; code: string; message: string; blockingErrors?: string[]; more?: false };

export interface CatalogActionContext {
  prisma: PrismaClient;
  store: StoreContext;
  /** the authenticated Admin GraphQL client from `authenticate.admin(request)` */
  admin: AdminGraphqlClientLike;
  /** the actor identity, from the authenticated session — never the form body. Only the
   * opaque staff-user id; staff email is deliberately not collected or stored. */
  actor: { userId: string | null };
  /** `readShopPolicyContext(admin)` output — required before any processing */
  shopPolicy: ShopPolicyContext;
  /** streams a bulk-result file; injected so tests never hit the network */
  fetchResult?: AdvanceSyncDeps["fetchResult"];
  now?: () => Date;
}

/** Intents that act on an existing job — the job MUST belong to this shop. */
const JOB_INTENTS = new Set(["apply", "job.process", "job.retry", "job.resume", "rollback.plan", "rollback.process"]);

export async function handleCatalogAdminAction(ctx: CatalogActionContext, form: FormData): Promise<CatalogActionResult> {
  const intent = String(form.get("intent") ?? "");
  const { prisma, store } = ctx;

  // Cross-tenant guard: every job-targeting action is rejected up front unless the job id
  // resolves to a job owned by THIS shop. (apply targets a dry_run job by `jobId`.)
  if (JOB_INTENTS.has(intent)) {
    const jobId = requireId(form, "jobId");
    if (!jobId) return fail(intent, "NO_JOB", "a job id is required");
    const owned = await prisma.bulkAssignmentJob.findFirst({ where: { id: jobId, storeId: store.storeId }, select: { id: true } });
    if (!owned) return fail(intent, "JOB_NOT_FOUND", "no such job for this shop");
  }

  switch (intent) {
    // -------------------------------------------------------- SKU auto-link
    case "linkBySku": {
      if (!ctx.shopPolicy.ok) return fail(intent, "SHOP_POLICY_UNREADABLE", "could not read the shop's currency and policy — try again");

      // This path is deliberately separate from bulk assignment. It only applies a
      // one-to-one profile/SKU match; profiles with no product or multiple candidates
      // are reported and left unassigned.
      const report = await buildLinkReport(prisma, ctx.admin, store.storeId);
      const applied = await applyLinkReport(prisma, ctx.admin, store.storeId, report);
      if (applied.errors.length) {
        return fail(intent, "SKU_LINK_PARTIAL", `SKU matching completed with ${applied.errors.length} Shopify write error(s).`, applied.errors.slice(0, 10));
      }
      return {
        ok: true,
        intent,
        message: `SKU matching complete: ${report.matched.length} unique profile match(es), ${applied.written} Shopify policy write(s), ${report.heldBack.length} profile(s) held back because they were unmatched or ambiguous.`,
        more: false,
        data: {
          matched: report.matched.length,
          written: applied.written,
          heldBack: report.heldBack.length,
          heldBackReasons: report.heldBack.slice(0, 25),
          policyCounts: report.counts,
        },
      };
    }

    // ---------------------------------------------------------------- sync
    case "sync.start": {
      const idempotencyKey = String(form.get("idempotencyKey") ?? `sync-${Date.now()}`).slice(0, 128);
      const started = await startCatalogSync(prisma, store.storeId, ctx.admin, idempotencyKey, ctx.now);
      if (!started.ok) return fail(intent, started.code, started.message, started.activeJobId ? [`active job: ${started.activeJobId}`] : undefined);
      return {
        ok: true,
        intent,
        // Deliberately NOT "complete": the bulk operation has only just been started.
        message: `Synchronization started. Shopify is building the catalog export (${started.state.bulkOperationStatus ?? "CREATED"}).`,
        more: !started.state.done,
        data: {
          syncJobId: started.state.jobId,
          state: started.state,
          // Task 6A.4B.1 — the ONLY correct continuation of `sync.start` is `sync.advance`.
          // A caller that keeps resubmitting `sync.start` (the bug this task fixed) gets
          // back the SAME idempotent-replay state forever without ever polling Shopify
          // again — the job looks permanently stuck at whatever status it had the instant
          // it was created. Naming the next intent here removes that footgun.
          continueIntent: "sync.advance",
          retryAfterMs: started.state.retryAfterMs,
        },
      };
    }

    case "sync.advance": {
      const jobId = requireId(form, "syncJobId");
      if (!jobId) return fail(intent, "NO_JOB", "a synchronization id is required");
      if (!ctx.fetchResult) return fail(intent, "NO_FETCHER", "no bulk-result fetcher is configured");
      const res = await advanceCatalogSync(prisma, store.storeId, jobId, {
        admin: ctx.admin,
        fetchResult: ctx.fetchResult,
        maxObjects: SYNC_OBJECTS_PER_REQUEST,
        now: ctx.now,
      });
      if (!res.ok) return fail(intent, res.code, res.message, res.state ? [`status: ${res.state.status}`] : undefined);
      const s = res.state;
      return {
        ok: true,
        intent,
        message: describeSync(s),
        more: !s.done,
        data: { syncJobId: s.jobId, state: s, continueIntent: "sync.advance", retryAfterMs: s.retryAfterMs },
      };
    }

    // ------------------------------------------------------------- dry run
    case "dryRun": {
      const selection = parseSelection(form);
      if ("error" in selection) return fail(intent, selection.code, selection.error);
      const pricingProfileId = requireId(form, "pricingProfileId");
      if (!pricingProfileId) return fail(intent, "NO_PROFILE", "select a pricing profile");
      if (!ctx.shopPolicy.ok) return fail(intent, "SHOP_POLICY_UNREADABLE", "could not read the shop's currency and policy — try again");

      // A dry run whose selection would touch EVERY product is refused unless the caller
      // sent an explicit acknowledgement. This is the guard added after an unfiltered
      // one-click "assign the whole catalog" reassigned 257 products by accident — it
      // makes the whole-catalog case a deliberate two-step choice, on the server, not
      // just a client hint that a replayed request could skip.
      const replaceExisting = form.get("replaceExisting") === "1";
      if (selectionTargetsWholeCatalog(selection.value) && form.get("acknowledgeWholeCatalog") !== "1") {
        return fail(
          intent,
          "WHOLE_CATALOG_NOT_ACKNOWLEDGED",
          "This dry run targets every product in the catalog. Add a filter to narrow it, or confirm the whole-catalog acknowledgement to continue.",
        );
      }

      const result = await planBulkAssignment(prisma, {
        storeId: store.storeId,
        shopDomain: store.shopDomain,
        shopCurrency: ctx.shopPolicy.shopCurrency,
        selection: selection.value,
        pricingProfileId,
        replaceExisting,
        createdByUserId: ctx.actor.userId,
        idempotencyKey: String(form.get("idempotencyKey") ?? `dry-${Date.now()}`).slice(0, 128),
      });
      if (!result.ok) return fail(intent, result.code, result.message, result.blockingErrors);
      return {
        ok: true,
        intent,
        message: "Dry run complete. Review the plan, then confirm to create the job.",
        more: false,
        data: {
          jobId: result.jobId,
          dryRunFingerprint: result.dryRunFingerprint,
          expiresAt: result.expiresAt.toISOString(),
          profile: result.profile,
          counts: result.counts,
          replaceExisting,
          wholeCatalog: selectionTargetsWholeCatalog(selection.value),
          blockingErrors: result.blockingErrors,
        },
      };
    }

    // --------------------------------------------------------------- apply
    case "apply": {
      if (!ctx.shopPolicy.ok) return fail(intent, "SHOP_POLICY_UNREADABLE", "could not read the shop enforcement policy — refusing to apply");
      const jobId = requireId(form, "jobId");
      const echoedFingerprint = String(form.get("dryRunFingerprint") ?? "");
      if (!jobId || !echoedFingerprint) return fail(intent, "MISSING_EVIDENCE", "dry-run evidence is required");

      const result = await confirmAndCreateJob(prisma, {
        storeId: store.storeId,
        shopDomain: store.shopDomain,
        shopCurrency: ctx.shopPolicy.shopCurrency,
        jobId,
        echoedFingerprint,
        shopEnforcementPolicyJson: ctx.shopPolicy.enforcementPolicyJson,
      });
      if (!result.ok) return fail(intent, result.code, result.message);
      return {
        ok: true,
        intent,
        // Deliberately NOT "complete": nothing has been written to Shopify yet.
        message: `Job created with ${result.totalItems} product(s) to write. Processing has not started.`,
        more: result.totalItems > 0,
        data: { jobId: result.jobId, totalItems: result.totalItems, batchSize: result.batchSize },
      };
    }

    // ------------------------------------------------------------ process
    case "job.process": {
      if (!ctx.shopPolicy.ok) return fail(intent, "SHOP_POLICY_UNREADABLE", "could not read the shop enforcement policy — refusing to process");
      const jobId = requireId(form, "jobId");
      if (!jobId) return fail(intent, "NO_JOB", "job id required");

      const owned = await prisma.bulkAssignmentJob.findFirst({ where: { id: jobId, storeId: store.storeId }, select: { jobType: true } });
      if (!owned) return fail(intent, "JOB_NOT_FOUND", "no such job for this shop");
      if (owned.jobType !== "assign") return fail(intent, "WRONG_JOB_TYPE", "use rollback.process for a rollback job");

      const result = await processAssignmentJob(prisma, store.storeId, jobId, {
        port: createAdminWritePort(ctx.admin),
        shopEnforcementPolicyJson: ctx.shopPolicy.enforcementPolicyJson,
        maxBatches: ASSIGN_BATCHES_PER_REQUEST,
        now: ctx.now,
      });
      if (result.refused && result.refused.reason !== "busy") {
        return fail(intent, "ENFORCEMENT_ENABLED", result.refused.message);
      }
      return {
        ok: true,
        intent,
        message: describeAssignment(result),
        more: result.more,
        data: { jobId, result, continueIntent: "job.process" },
      };
    }

    case "job.retry": {
      const jobId = requireId(form, "jobId");
      if (!jobId) return fail(intent, "NO_JOB", "job id required");
      const r = await requeueFailedItems(prisma, store.storeId, jobId);
      return {
        ok: true,
        intent,
        message:
          r.requeued > 0
            ? `${r.requeued} failed item(s) re-queued.${r.permanent ? ` ${r.permanent} could not be retried automatically (conflicts or permanent errors).` : ""}`
            : `Nothing to retry — ${r.permanent} failure(s) need manual review.`,
        more: r.requeued > 0,
        data: r,
      };
    }

    case "job.resume": {
      const jobId = requireId(form, "jobId");
      if (!jobId) return fail(intent, "NO_JOB", "job id required");
      const r = await resumeInterruptedJob(prisma, store.storeId, jobId, ctx.now?.());
      if (!r.resumed) return fail(intent, "NOT_RESUMABLE", r.reason ?? "this job cannot be resumed");
      return { ok: true, intent, message: "Job resumed. Continue processing to finish it.", more: true, data: { jobId } };
    }

    // ------------------------------------------------------------ rollback
    case "rollback.plan": {
      if (!ctx.shopPolicy.ok) return fail(intent, "SHOP_POLICY_UNREADABLE", "could not read the shop enforcement policy — refusing to plan a rollback");
      const jobId = requireId(form, "jobId");
      if (!jobId) return fail(intent, "NO_JOB", "job id required");
      const r = await planRollback(prisma, store.storeId, jobId, {
        shopEnforcementPolicyJson: ctx.shopPolicy.enforcementPolicyJson,
        createdByUserId: ctx.actor.userId,
      });
      if (!r.ok) return fail(intent, r.code, r.message);
      return {
        ok: true,
        intent,
        message: `Rollback planned for ${r.itemCount} product(s). Nothing has been restored yet.`,
        more: r.itemCount > 0,
        data: { rollbackJobId: r.jobId, itemCount: r.itemCount },
      };
    }

    case "rollback.process": {
      if (!ctx.shopPolicy.ok) return fail(intent, "SHOP_POLICY_UNREADABLE", "could not read the shop enforcement policy — refusing to process");
      const jobId = requireId(form, "jobId");
      if (!jobId) return fail(intent, "NO_JOB", "rollback job id required");
      const owned = await prisma.bulkAssignmentJob.findFirst({ where: { id: jobId, storeId: store.storeId }, select: { jobType: true } });
      if (!owned) return fail(intent, "JOB_NOT_FOUND", "no such job for this shop");
      if (owned.jobType !== "rollback") return fail(intent, "WRONG_JOB_TYPE", "use job.process for an assignment job");

      const result = await processRollbackJob(prisma, store.storeId, jobId, {
        port: createAdminWritePort(ctx.admin),
        shopEnforcementPolicyJson: ctx.shopPolicy.enforcementPolicyJson,
        force: form.get("force") === "1",
        maxBatches: ASSIGN_BATCHES_PER_REQUEST,
        now: ctx.now,
      });
      if (result.refused && result.refused.reason !== "busy") {
        return fail(intent, "ENFORCEMENT_ENABLED", result.refused.message);
      }
      return { ok: true, intent, message: describeRollback(result), more: result.more, data: { jobId, result, continueIntent: "rollback.process" } };
    }

    default:
      return fail(intent || "(none)", "UNKNOWN_INTENT", `unknown action "${intent}"`);
  }
}

// ---------------------------------------------------------------------------
// Merchant-facing progress messages — actionable, never an internal payload.
// ---------------------------------------------------------------------------

function describeSync(s: { status: string; bulkOperationStatus: string | null; productsUpserted: number; variantsUpserted: number; productsRemoved: number; errorMessage: string | null }): string {
  switch (s.status) {
    case "awaiting_bulk":
      return `Shopify is still building the catalog export (${s.bulkOperationStatus ?? "RUNNING"}). Keep checking.`;
    case "ingesting":
      return `Importing… ${s.productsUpserted} product(s) and ${s.variantsUpserted} variant(s) so far.`;
    case "completed":
      return `Synchronization complete: ${s.productsUpserted} product(s), ${s.variantsUpserted} variant(s)${s.productsRemoved ? `, ${s.productsRemoved} no longer in Shopify` : ""}.`;
    case "partial":
      return `Synchronization finished with partial data: ${s.productsUpserted} product(s) imported. Run it again for a complete catalog.`;
    case "failed":
      return `Synchronization failed. ${s.errorMessage ?? "Try running it again."}`;
    default:
      return `Synchronization ${s.status}.`;
  }
}

function describeAssignment(r: { status: string; succeeded: number; unchanged: number; failed: number; conflicts: number; remaining: number; more: boolean }): string {
  if (r.more) {
    return `Assigning… ${r.succeeded} written, ${r.unchanged} already correct, ${r.failed} failed, ${r.remaining} to go.`;
  }
  if (r.status === "completed") return `Assignment complete: ${r.succeeded} written, ${r.unchanged} already correct.`;
  if (r.status === "partial") {
    return `Assignment finished with ${r.failed} failure(s)${r.conflicts ? `, ${r.conflicts} of which were changed by someone else and were not overwritten` : ""}. ${r.succeeded} product(s) were written.`;
  }
  if (r.status === "failed") return `Assignment failed — no products were written. Review the item errors.`;
  return `Assignment ${r.status}.`;
}

function describeRollback(r: { status: string; restored: number; unchanged: number; conflicts: number; failed: number; remaining: number; more: boolean }): string {
  const alreadyOk = r.unchanged ? `, ${r.unchanged} already at the previous state (no change)` : "";
  if (r.more) return `Restoring… ${r.restored} restored${alreadyOk}, ${r.remaining} to go.`;
  if (r.status === "rolled_back") {
    return r.restored === 0 && r.unchanged > 0
      ? `Rollback complete: nothing to undo — ${r.unchanged} product(s) were already at the previous state.`
      : `Rollback complete: ${r.restored} product(s) restored${alreadyOk}.`;
  }
  if (r.status === "partial") {
    return `Rollback finished with ${r.conflicts} conflict(s) and ${r.failed} other failure(s); ${r.restored} product(s) were restored${alreadyOk}. Conflicted products were changed after the assignment and were left untouched.`;
  }
  if (r.status === "failed") return `Rollback failed — nothing was restored. Review the item errors.`;
  return `Rollback ${r.status}.`;
}

// ---------------------------------------------------------------------------

function fail(intent: string, code: string, message: string, blockingErrors?: string[]): CatalogActionResult {
  return { ok: false, intent, code, message, blockingErrors };
}

function parseSelection(form: FormData): { value: SelectionDescriptor } | { error: string; code: string } {
  const raw = form.get("selection");
  if (typeof raw !== "string" || !raw) return { error: "selection is required", code: "NO_SELECTION" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "selection is not valid JSON", code: "MALFORMED_SELECTION" };
  }
  try {
    return { value: parseSelectionDescriptor(parsed) };
  } catch (error) {
    if (error instanceof SelectionError) return { error: error.message, code: error.code };
    throw error;
  }
}

function requireId(form: FormData, field: string): string | null {
  const v = form.get(field);
  return typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null;
}

/**
 * Production bulk-result fetcher: an HTTP `Range` request from `startByteOffset`, yielding
 * the response body as a byte stream. Never buffers the whole file.
 */
export function createResultFetcher(): AdvanceSyncDeps["fetchResult"] {
  return async (url: string, startByteOffset: number) => {
    const res = await fetch(url, {
      headers: startByteOffset > 0 ? { Range: `bytes=${startByteOffset}-` } : {},
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`bulk result fetch failed with status ${res.status}`);
    }
    if (!res.body) throw new Error("bulk result response has no body");
    return res.body as unknown as AsyncIterable<Uint8Array>;
  };
}
