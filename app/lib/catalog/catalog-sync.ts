/**
 * Task 6A / 6A.1 — full-catalog synchronization, driven by BOUNDED Admin requests.
 *
 * STATE MACHINE (each transition is one bounded, leased, resumable request)
 *
 *   queued ──startCatalogSync──▶ awaiting_bulk ──advance──▶ ingesting ──advance*──▶ completed
 *                                     │                          │
 *                                     └── FAILED/CANCELED ───────┴──▶ partial | failed
 *
 * EXACT BULK-OPERATION OWNERSHIP (6A.1)
 *   - `bulkOperationRunQuery` returns a BulkOperation GID; it is persisted on the job.
 *   - Polling uses `bulkOperation(id: $id)` (via `node(id:)`) and asserts the returned id
 *     equals the stored one, that `__typename` is `BulkOperation`, and that `type` is
 *     `QUERY`. `currentBulkOperation` is used ONLY to detect a pre-existing in-flight
 *     operation before starting a new one — never to decide which result file to ingest.
 *   - At most one non-terminal catalog sync per shop, enforced by the database
 *     (`@@unique([storeId, activeSentinel])`), so two concurrent starts cannot both
 *     attach to a bulk operation.
 *
 * INGEST
 *   - Line-oriented streaming parse; only the current partial line plus a one-product
 *     lookahead is ever in memory.
 *   - Each request ingests at most `maxObjects` JSONL lines and stops on a PRODUCT
 *     boundary, checkpointing `resumeByteOffset` at the byte where the next product line
 *     begins, so the next request resumes exactly there via an HTTP `Range` request.
 *   - Products AND their full variant sets (nested bulk connection, no `first:` boundary)
 *     are upserted idempotently, store-scoped.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  BULK_OPERATION_BY_ID_QUERY,
  BULK_OPERATION_RUN_QUERY,
  CATALOG_BULK_QUERY,
  CURRENT_BULK_OPERATION_QUERY,
  SHOP_CURRENCY_QUERY,
  adminRequest,
  type AdminGraphqlClientLike,
} from "./admin-client.ts";
import { RECONCILE_BATCH_SIZE, SYNC_OBJECTS_PER_REQUEST } from "./constants.ts";
import { reconcileCoverageAfterSync } from "./coverage.ts";
import { parseJsonl, type JsonlRecord } from "./jsonl.ts";
import { parseProductGid, parseVariantGid } from "./gid.ts";
import { acquireSyncLease, newWorkerToken, releaseSyncLease, renewSyncLease, LeaseGuard } from "./leases.ts";
import { normalizeCurrencyCode } from "../pricing-api/currency-contract.ts";

/** Products per `INSERT ... ON CONFLICT` statement (17 bound parameters per product). */
const UPSERT_BATCH_SIZE = 200;
/** The sentinel that makes "one active sync per shop" a database constraint. */
export const ACTIVE_SYNC_SENTINEL = "active";

/**
 * Task 6A.4B.1 — bounded backoff for polling a bulk operation that is still CREATED or
 * RUNNING. A poll in that state does no useful work (nothing to ingest yet) and is pure
 * Shopify-API + browser-request cost, so the wait GROWS the longer Shopify takes, capped so
 * a slow export is still checked periodically. `ingesting` steps are excluded — each of
 * those consumes real bounded work (`SYNC_OBJECTS_PER_REQUEST` lines), so, like the
 * assignment processor's batches, they are meant to be called back-to-back with no
 * artificial delay.
 */
export function computeBulkPollBackoffMs(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1_000;
  if (elapsedMs < 30_000) return 2_000;
  if (elapsedMs < 120_000) return 5_000;
  return 15_000;
}

export const ACTIVE_SYNC_STATUSES = ["queued", "awaiting_bulk", "ingesting", "running"] as const;

export interface CatalogSyncState {
  jobId: string;
  status: string;
  bulkOperationId: string | null;
  bulkOperationStatus: string | null;
  objectsSeen: number;
  productsUpserted: number;
  productsRemoved: number;
  variantsSeen: number;
  variantsUpserted: number;
  variantsRemoved: number;
  resumeByteOffset: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** true when the caller should invoke `advanceCatalogSync` again */
  done: boolean;
  /**
   * Task 6A.4B.1 — how long the caller MUST wait before its next `sync.advance` call,
   * milliseconds. Non-null only while genuinely waiting on Shopify (CREATED/RUNNING) with
   * nothing to ingest yet; `null` for a terminal job or one with real bounded work to do
   * right now (`ingesting`), which should be called back-to-back.
   */
  retryAfterMs: number | null;
}

// ---------------------------------------------------------------------------
// 1. Start
// ---------------------------------------------------------------------------

export type StartSyncResult =
  | { ok: true; state: CatalogSyncState; created: boolean }
  | { ok: false; code: string; message: string; activeJobId?: string };

/**
 * Creates a catalog sync job and starts its bulk operation.
 *
 * Refuses when this shop already has a non-terminal sync (the DB unique index on
 * `[storeId, activeSentinel]` is the authority, so two concurrent requests cannot both
 * win), and when the app already has an in-flight query bulk operation on this shop that
 * no job of ours owns.
 */
export async function startCatalogSync(
  prisma: PrismaClient,
  storeId: string,
  admin: AdminGraphqlClientLike,
  idempotencyKey: string,
  now: () => Date = () => new Date(),
): Promise<StartSyncResult> {
  // Idempotent replay of the same key returns the existing job untouched.
  const existingByKey = await prisma.catalogSyncJob.findUnique({
    where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
  });
  if (existingByKey) {
    return { ok: true, created: false, state: toState(existingByKey) };
  }

  const active = await prisma.catalogSyncJob.findFirst({
    where: { storeId, activeSentinel: ACTIVE_SYNC_SENTINEL },
    select: { id: true, status: true },
  });
  if (active) {
    return {
      ok: false,
      code: "SYNC_ALREADY_ACTIVE",
      message: `a catalog synchronization is already ${active.status} for this shop`,
      activeJobId: active.id,
    };
  }

  // Claim the single active slot. A concurrent request loses on the unique index.
  let job;
  try {
    job = await prisma.catalogSyncJob.create({
      data: {
        storeId,
        idempotencyKey,
        status: "queued",
        activeSentinel: ACTIVE_SYNC_SENTINEL,
        startedAt: now(),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const other = await prisma.catalogSyncJob.findFirst({
        where: { storeId, activeSentinel: ACTIVE_SYNC_SENTINEL },
        select: { id: true },
      });
      return { ok: false, code: "SYNC_ALREADY_ACTIVE", message: "another synchronization started first", activeJobId: other?.id };
    }
    throw error;
  }

  // Refresh shop currency (small, always-on) — drives the enforcement-ready metric.
  try {
    const cur = await adminRequest(admin, SHOP_CURRENCY_QUERY);
    const code = normalizeCurrencyCode((cur.shop as { currencyCode?: unknown } | undefined)?.currencyCode);
    if (code) await prisma.store.update({ where: { id: storeId }, data: { shopCurrency: code } });
  } catch {
    /* non-fatal */
  }

  // Refuse to start if the app already has an in-flight query bulk operation that no job
  // of ours owns — starting another would have Shopify reject it, or worse, leave two
  // operations whose identity we cannot tell apart.
  try {
    const cur = await adminRequest(admin, CURRENT_BULK_OPERATION_QUERY);
    const op = cur.currentBulkOperation as { id?: string; status?: string } | null;
    if (op?.id && (op.status === "CREATED" || op.status === "RUNNING")) {
      const owner = await prisma.catalogSyncJob.findFirst({ where: { storeId, bulkOperationId: op.id }, select: { id: true } });
      if (!owner) {
        await failSync(prisma, job.id, "FOREIGN_BULK_OPERATION_IN_FLIGHT", `a bulk operation this app does not own is ${op.status}`);
        return {
          ok: false,
          code: "FOREIGN_BULK_OPERATION_IN_FLIGHT",
          message: "another bulk operation is already running for this app on this shop — wait for it to finish",
        };
      }
    }
  } catch {
    /* a poll failure here is not fatal; the start below will surface a real problem */
  }

  try {
    const data = await adminRequest(admin, BULK_OPERATION_RUN_QUERY, { query: CATALOG_BULK_QUERY });
    const r = data.bulkOperationRunQuery as
      | { bulkOperation?: { id?: string; status?: string }; userErrors?: Array<{ message: string }> }
      | undefined;
    if (r?.userErrors?.length) {
      await failSync(prisma, job.id, "BULK_START_REJECTED", r.userErrors.map((e) => e.message).join("; "));
      return { ok: false, code: "BULK_START_REJECTED", message: r.userErrors.map((e) => e.message).join("; ") };
    }
    const bulkOperationId = r?.bulkOperation?.id ?? null;
    if (!bulkOperationId) {
      await failSync(prisma, job.id, "BULK_START_NO_ID", "no bulk operation id returned");
      return { ok: false, code: "BULK_START_NO_ID", message: "Shopify returned no bulk operation id" };
    }
    const updated = await prisma.catalogSyncJob.update({
      where: { id: job.id },
      data: { bulkOperationId, bulkOperationStatus: r?.bulkOperation?.status ?? "CREATED", status: "awaiting_bulk" },
    });
    return { ok: true, created: true, state: toState(updated) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSync(prisma, job.id, "BULK_START_ERROR", message);
    return { ok: false, code: "BULK_START_ERROR", message: message.slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// 2. Advance — one bounded, leased step
// ---------------------------------------------------------------------------

export interface AdvanceSyncDeps {
  admin: AdminGraphqlClientLike;
  /** Streams the bulk-result file from `url`, honouring `startByteOffset` (an HTTP
   * `Range` request in production, a slice in tests). */
  fetchResult: (url: string, startByteOffset: number) => Promise<AsyncIterable<Uint8Array>>;
  /** Max JSONL lines this request may consume. Keeps one Admin request bounded. */
  maxObjects?: number;
  now?: () => Date;
  workerToken?: string;
}

export type AdvanceSyncResult =
  | { ok: true; state: CatalogSyncState }
  | { ok: false; code: string; message: string; state?: CatalogSyncState };

export async function advanceCatalogSync(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  deps: AdvanceSyncDeps,
): Promise<AdvanceSyncResult> {
  const now = deps.now ?? (() => new Date());
  const token = deps.workerToken ?? newWorkerToken("sync");

  const lease = await acquireSyncLease(prisma, storeId, jobId, token, now());
  if (!lease.acquired) {
    const job = await prisma.catalogSyncJob.findFirst({ where: { id: jobId, storeId } });
    if (lease.reason === "not_found" || !job) return { ok: false, code: "SYNC_NOT_FOUND", message: "no such synchronization for this shop" };
    if (lease.reason === "terminal") return { ok: true, state: toState(job) };
    return { ok: false, code: "SYNC_BUSY", message: "another request is processing this synchronization", state: toState(job) };
  }

  const guard = new LeaseGuard(
    (at) => renewSyncLease(prisma, storeId, jobId, token, at),
    lease.expiresAt,
    now,
  );

  try {
    const job = await prisma.catalogSyncJob.findFirstOrThrow({ where: { id: jobId, storeId } });

    if (job.status === "awaiting_bulk" || job.status === "queued") {
      return await pollOwnedBulkOperation(prisma, storeId, job, deps, now);
    }
    if (job.status === "ingesting") {
      return await ingestBoundedStep(prisma, storeId, job, deps, now, guard);
    }
    return { ok: true, state: toState(job) };
  } finally {
    await releaseSyncLease(prisma, storeId, jobId, token);
  }
}

type SyncJobRow = Prisma.CatalogSyncJobGetPayload<Record<string, never>>;

/** Polls the EXACT operation this job owns and verifies its identity. */
async function pollOwnedBulkOperation(
  prisma: PrismaClient,
  storeId: string,
  job: SyncJobRow,
  deps: AdvanceSyncDeps,
  now: () => Date,
): Promise<AdvanceSyncResult> {
  if (!job.bulkOperationId) {
    const failed = await failSync(prisma, job.id, "BULK_OPERATION_MISSING", "this job has no bulk operation to poll");
    return { ok: false, code: "BULK_OPERATION_MISSING", message: "this synchronization has no bulk operation", state: toState(failed) };
  }

  let node: {
    __typename?: string;
    id?: string;
    status?: string;
    errorCode?: string | null;
    objectCount?: string | number | null;
    url?: string | null;
    partialDataUrl?: string | null;
    type?: string | null;
  } | null;
  try {
    const data = await adminRequest(deps.admin, BULK_OPERATION_BY_ID_QUERY, { id: job.bulkOperationId });
    node = (data.node ?? null) as typeof node;
  } catch (error) {
    return { ok: false, code: "BULK_POLL_ERROR", message: error instanceof Error ? error.message.slice(0, 300) : "poll failed", state: toState(job) };
  }

  // --- identity assertions: this must be OUR operation ---
  if (!node) {
    const failed = await failSync(prisma, job.id, "BULK_OPERATION_NOT_FOUND", `bulk operation ${job.bulkOperationId} no longer exists`);
    return { ok: false, code: "BULK_OPERATION_NOT_FOUND", message: "the bulk operation this job started no longer exists", state: toState(failed) };
  }
  if (node.__typename !== "BulkOperation") {
    const failed = await failSync(prisma, job.id, "BULK_OPERATION_WRONG_TYPE", `node ${job.bulkOperationId} is a ${node.__typename ?? "unknown"}, not a BulkOperation`);
    return { ok: false, code: "BULK_OPERATION_WRONG_TYPE", message: "the stored bulk operation id does not identify a bulk operation", state: toState(failed) };
  }
  if (node.id !== job.bulkOperationId) {
    const failed = await failSync(prisma, job.id, "BULK_OPERATION_ID_MISMATCH", "Shopify returned a different bulk operation id than the one this job owns");
    return { ok: false, code: "BULK_OPERATION_ID_MISMATCH", message: "bulk operation identity mismatch — refusing to ingest", state: toState(failed) };
  }
  if (node.type != null && node.type !== "QUERY") {
    const failed = await failSync(prisma, job.id, "BULK_OPERATION_WRONG_KIND", `bulk operation type is ${node.type}, not QUERY`);
    return { ok: false, code: "BULK_OPERATION_WRONG_KIND", message: "the owned bulk operation is not a query operation", state: toState(failed) };
  }
  // Cross-job ownership: no OTHER job (in any store) may already own this operation id.
  const otherOwner = await prisma.catalogSyncJob.findFirst({
    where: { bulkOperationId: job.bulkOperationId, NOT: { id: job.id } },
    select: { id: true, storeId: true },
  });
  if (otherOwner) {
    const failed = await failSync(prisma, job.id, "BULK_OPERATION_ALREADY_OWNED", "another synchronization job already owns this bulk operation");
    return { ok: false, code: "BULK_OPERATION_ALREADY_OWNED", message: "bulk operation is owned by another job — refusing to ingest", state: toState(failed) };
  }

  const objectCount = Number(node.objectCount ?? 0) || 0;

  if (node.status === "COMPLETED") {
    if (!node.url) {
      // Zero objects → Shopify returns no url. Nothing to stream; still detect removals.
      const removedProducts = await markRemovedProducts(prisma, storeId, job.id, now());
      const removedVariants = await markRemovedVariants(prisma, storeId, job.id, now());
      const done = await completeSync(prisma, job.id, now(), { productsRemoved: removedProducts, variantsRemoved: removedVariants, bulkOperationStatus: "COMPLETED", bulkOperationObjects: objectCount });
      return { ok: true, state: toState(done) };
    }
    const updated = await prisma.catalogSyncJob.update({
      where: { id: job.id },
      data: { status: "ingesting", resultUrl: node.url, bulkOperationStatus: "COMPLETED", bulkOperationObjects: objectCount },
    });
    return { ok: true, state: toState(updated) };
  }

  if (node.status === "FAILED" || node.status === "CANCELED" || node.status === "EXPIRED") {
    if (node.partialDataUrl) {
      const updated = await prisma.catalogSyncJob.update({
        where: { id: job.id },
        data: {
          status: "ingesting",
          resultUrl: node.partialDataUrl,
          bulkOperationStatus: node.status,
          bulkOperationObjects: objectCount,
          errorCode: node.errorCode ?? `BULK_${node.status}`,
          errorMessage: "bulk operation returned partial data",
        },
      });
      return { ok: true, state: toState(updated) };
    }
    const failed = await failSync(prisma, job.id, node.errorCode ?? `BULK_${node.status}`, `bulk operation ${node.status}`);
    return { ok: false, code: "BULK_OPERATION_FAILED", message: `the bulk operation ${String(node.status).toLowerCase()}`, state: toState(failed) };
  }

  // CREATED / RUNNING — still working. Report progress; the caller polls again.
  const updated = await prisma.catalogSyncJob.update({
    where: { id: job.id },
    data: { status: "awaiting_bulk", bulkOperationStatus: node.status ?? "RUNNING", bulkOperationObjects: objectCount },
  });
  return { ok: true, state: toState(updated) };
}

/** Ingests at most `maxObjects` JSONL lines, then checkpoints and returns. */
async function ingestBoundedStep(
  prisma: PrismaClient,
  storeId: string,
  job: SyncJobRow,
  deps: AdvanceSyncDeps,
  now: () => Date,
  guard: LeaseGuard,
): Promise<AdvanceSyncResult> {
  if (!job.resultUrl) {
    const failed = await failSync(prisma, job.id, "NO_RESULT_URL", "no bulk result url to ingest");
    return { ok: false, code: "NO_RESULT_URL", message: "no result file to ingest", state: toState(failed) };
  }

  const maxObjects = deps.maxObjects ?? SYNC_OBJECTS_PER_REQUEST;
  let outcome: BoundedIngestOutcome;
  try {
    const stream = await deps.fetchResult(job.resultUrl, job.resumeByteOffset);
    outcome = await ingestJsonlBounded(
      prisma,
      storeId,
      job.id,
      parseJsonl(stream, { startByteOffset: job.resumeByteOffset }),
      { maxObjects, now, guard },
    );
  } catch (error) {
    const detail = describeIngestError(error);
    const failed = await failSync(prisma, job.id, "INGEST_ERROR", detail, "partial");
    return { ok: false, code: "INGEST_ERROR", message: `the result stream could not be read — the job can be resumed (${detail})`, state: toState(failed) };
  }

  if (!outcome.reachedEnd) {
    const updated = await prisma.catalogSyncJob.findFirstOrThrow({ where: { id: job.id, storeId } });
    return { ok: true, state: toState(updated) };
  }

  const removedProducts = await markRemovedProducts(prisma, storeId, job.id, now());
  const removedVariants = await markRemovedVariants(prisma, storeId, job.id, now());
  const wasPartial = job.bulkOperationStatus === "FAILED" || job.bulkOperationStatus === "CANCELED" || job.bulkOperationStatus === "EXPIRED";
  const done = wasPartial
    ? await finishSync(prisma, job.id, "partial", now(), { productsRemoved: removedProducts, variantsRemoved: removedVariants })
    : await completeSync(prisma, job.id, now(), { productsRemoved: removedProducts, variantsRemoved: removedVariants });
  // A sync can insert products that already have an override and drop products an override
  // covered, so refresh the derived coverage columns. Scoped to products that have an override
  // or are marked covered, and best-effort: it can never fail a sync that already finished.
  await reconcileCoverageAfterSync(prisma, storeId);
  return { ok: true, state: toState(done) };
}

// ---------------------------------------------------------------------------
// 3. The testable ingest core
// ---------------------------------------------------------------------------

interface NormalizedProduct {
  shopifyProductId: string;
  title: string;
  handle: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  tags: string;
  variantCount: number;
  hasAnySku: boolean;
  shopifyUpdatedAt: Date | null;
  variants: NormalizedVariant[];
}

interface NormalizedVariant {
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  position: number;
  shopifyUpdatedAt: Date | null;
}

export interface BoundedIngestOutcome {
  objectsConsumed: number;
  productsFlushed: number;
  variantsFlushed: number;
  byteOffsetAfter: number;
  reachedEnd: boolean;
  leaseLost: boolean;
}

/**
 * Consumes flattened bulk-query JSONL. Product lines are buffered one-deep; variant lines
 * (which always follow their parent) accumulate onto that buffer via `__parentId`, with
 * NO count boundary — a product with 400 variants yields all 400.
 *
 * Stops after `maxObjects` lines, but always on a product boundary, checkpointing
 * `resumeByteOffset` at the byte where the next product line begins.
 */
export async function ingestJsonlBounded(
  prisma: PrismaClient,
  storeId: string,
  syncJobId: string,
  records: AsyncIterable<JsonlRecord>,
  opts: { maxObjects?: number; now?: () => Date; guard?: LeaseGuard } = {},
): Promise<BoundedIngestOutcome> {
  const maxObjects = opts.maxObjects ?? Number.MAX_SAFE_INTEGER;
  const now = opts.now ?? (() => new Date());

  const job = await prisma.catalogSyncJob.findFirstOrThrow({ where: { id: syncJobId } });
  let objectsSeen = job.objectsSeen;
  let variantsSeen = job.variantsSeen;
  let productsUpserted = job.productsUpserted;
  let variantsUpserted = job.variantsUpserted;

  let current: NormalizedProduct | null = null;
  let batch: NormalizedProduct[] = [];
  let objectsConsumed = 0;
  let productsFlushed = 0;
  let variantsFlushed = 0;
  let checkpoint = job.resumeByteOffset;
  let reachedEnd = true;
  let leaseLost = false;

  const flush = async (byteOffset: number) => {
    if (batch.length === 0) {
      checkpoint = byteOffset;
      return;
    }
    const written = await upsertProductBatch(prisma, storeId, syncJobId, batch, now());
    productsUpserted += batch.length;
    variantsUpserted += written.variants;
    productsFlushed += batch.length;
    variantsFlushed += written.variants;
    batch = [];
    checkpoint = byteOffset;
    await prisma.catalogSyncJob.update({
      where: { id: syncJobId },
      data: { resumeByteOffset: checkpoint, objectsSeen, variantsSeen, productsUpserted, variantsUpserted },
    });
  };

  for await (const rec of records) {
    const node = rec.value;
    const parentId = typeof node.__parentId === "string" ? node.__parentId : null;

    if (parentId === null) {
      // A product line. Close out the previous product first.
      if (current) {
        batch.push(current);
        current = null;
        if (batch.length >= UPSERT_BATCH_SIZE) await flush(rec.byteStart);
      }
      // Bounded stop: only ever between products, never mid-variant-set.
      if (objectsConsumed >= maxObjects || (opts.guard && !(await opts.guard.check()))) {
        if (opts.guard?.isLost) leaseLost = true;
        await flush(rec.byteStart);
        reachedEnd = false;
        break;
      }
      objectsConsumed += 1;
      objectsSeen += 1;
      current = normalizeProduct(node);
      continue;
    }

    // A child (variant) line — attach to the buffered parent.
    objectsConsumed += 1;
    objectsSeen += 1;
    variantsSeen += 1;
    if (current && parseProductGid(parentId) === current.shopifyProductId) {
      const variant = normalizeVariant(node, current.variants.length);
      if (variant) {
        current.variants.push(variant);
        if (variant.sku) current.hasAnySku = true;
      }
    }
  }

  if (reachedEnd) {
    if (current) batch.push(current);
    // End of stream: the checkpoint is the end of everything consumed.
    const endOffset = checkpoint;
    await flush(endOffset);
  }

  await prisma.catalogSyncJob.update({
    where: { id: syncJobId },
    data: { objectsSeen, variantsSeen, productsUpserted, variantsUpserted, ...(reachedEnd ? {} : { resumeByteOffset: checkpoint }) },
  });

  return { objectsConsumed, productsFlushed, variantsFlushed, byteOffsetAfter: checkpoint, reachedEnd, leaseLost };
}

function normalizeProduct(node: Record<string, unknown>): NormalizedProduct {
  const gid = parseProductGid(node.id);
  if (!gid) throw new Error(`catalog line has no valid product id: ${JSON.stringify(node.id)}`);
  const vc = node.variantsCount as { count?: unknown } | number | undefined;
  const variantCount = typeof vc === "number" ? vc : Number((vc as { count?: unknown } | undefined)?.count ?? 0) || 0;
  return {
    shopifyProductId: gid,
    title: str(node.title) ?? "",
    handle: str(node.handle) ?? "",
    status: str(node.status) ?? "ACTIVE",
    vendor: str(node.vendor),
    productType: str(node.productType),
    tags: normalizeTags(node.tags),
    variantCount,
    hasAnySku: false,
    shopifyUpdatedAt: parseDate(node.updatedAt),
    variants: [],
  };
}

function normalizeVariant(node: Record<string, unknown>, position: number): NormalizedVariant | null {
  const gid = parseVariantGid(node.id);
  if (!gid) return null;
  const rawSku = typeof node.sku === "string" ? node.sku.trim() : "";
  return {
    shopifyVariantId: gid,
    title: str(node.title) ?? "",
    sku: rawSku.length > 0 ? rawSku : null,
    position,
    shopifyUpdatedAt: parseDate(node.updatedAt),
  };
}

/** Rows per variant statement: 12 bound parameters per row, far below the protocol limit. */
const VARIANT_STATEMENT_ROWS = 500;

/** Last occurrence wins — what sequential upserts of the same product would have left behind. */
function lastWins<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

function inChunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Upserts a batch of products AND their full variant sets, store-scoped and idempotent.
 *
 * SET-BASED: one parameterized `INSERT … ON CONFLICT … DO UPDATE` statement per bounded
 * batch of products, and one per `VARIANT_STATEMENT_ROWS` variants, instead of one
 * round-trip per row. The cost therefore no longer scales with network latency × rows,
 * and no interactive-transaction time limit can be hit by a slow link.
 *
 * Semantics are those of the row-by-row version it replaced:
 *  - products: create sets first/last seen; update refreshes the descriptive fields and
 *    the seen markers, clears `removedFromShopifyAt`, and never touches `firstSeenAt`,
 *    the pricing-coverage columns, or the row id;
 *  - variants: a row whose sku/title/position are unchanged (and that is not marked
 *    removed) only has its seen marker refreshed; any other existing row is rewritten.
 *  - duplicates within one batch: a repeated PRODUCT id keeps the last occurrence (as the
 *    sequential upserts did); a repeated VARIANT id is rejected before anything is written
 *    (the old `createMany` failed on the unique constraint), so bad input is never hidden.
 * Every conflict target includes `storeId`, so a statement can only ever match this
 * store's rows.
 */
async function upsertProductBatch(
  prisma: PrismaClient,
  storeId: string,
  syncJobId: string,
  products: NormalizedProduct[],
  seenAt: Date,
): Promise<{ variants: number }> {
  const writtenAt = new Date(); // stands in for Prisma's client-side @updatedAt

  // O(n) duplicate-variant check BEFORE any statement runs, so a rejected batch writes nothing.
  // Only the Shopify variant GID is named in the error — never any other data.
  const seenVariantIds = new Set<string>();
  for (const p of products) {
    for (const v of p.variants) {
      if (seenVariantIds.has(v.shopifyVariantId)) {
        throw new Error(`duplicate variant id in one ingest batch: ${v.shopifyVariantId}`);
      }
      seenVariantIds.add(v.shopifyVariantId);
    }
  }

  const productRows = lastWins(products, (p) => p.shopifyProductId);
  const productValues = productRows.map(
    (p) => Prisma.sql`(${crypto.randomUUID()}, ${storeId}, ${p.shopifyProductId}, ${p.title}, ${p.handle}, ${p.status}, ${p.vendor}, ${p.productType}, ${p.tags}, ${p.variantCount || p.variants.length}, ${p.hasAnySku}, ${p.shopifyUpdatedAt}, ${seenAt}, ${seenAt}, ${syncJobId}, NULL, ${writtenAt})`,
  );
  const written = await prisma.$queryRaw<{ id: string; shopifyProductId: string }[]>(Prisma.sql`
    INSERT INTO "CatalogProduct"
      ("id", "storeId", "shopifyProductId", "title", "handle", "status", "vendor", "productType", "tags",
       "variantCount", "hasAnySku", "shopifyUpdatedAt", "firstSeenAt", "lastSeenAt", "lastSeenSyncId",
       "removedFromShopifyAt", "updatedAt")
    VALUES ${Prisma.join(productValues)}
    ON CONFLICT ("storeId", "shopifyProductId") DO UPDATE SET
      "title" = EXCLUDED."title",
      "handle" = EXCLUDED."handle",
      "status" = EXCLUDED."status",
      "vendor" = EXCLUDED."vendor",
      "productType" = EXCLUDED."productType",
      "tags" = EXCLUDED."tags",
      "variantCount" = EXCLUDED."variantCount",
      "hasAnySku" = EXCLUDED."hasAnySku",
      "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      "lastSeenSyncId" = EXCLUDED."lastSeenSyncId",
      "removedFromShopifyAt" = NULL,
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "id", "shopifyProductId"`);
  const idByGid = new Map(written.map((r) => [r.shopifyProductId, r.id]));

  const incoming = products.flatMap((p) =>
    p.variants.map((v) => {
      const catalogProductId = idByGid.get(p.shopifyProductId);
      if (!catalogProductId) throw new Error(`catalog product ${p.shopifyProductId} was not returned by its upsert`);
      return {
        catalogProductId,
        shopifyVariantId: v.shopifyVariantId,
        shopifyProductId: p.shopifyProductId,
        title: v.title,
        sku: v.sku,
        position: v.position,
        shopifyUpdatedAt: v.shopifyUpdatedAt,
      };
    }),
  );
  if (incoming.length === 0) return { variants: 0 };

  for (const chunk of inChunks(incoming, VARIANT_STATEMENT_ROWS)) {
    const variantValues = chunk.map(
      (v) => Prisma.sql`(${crypto.randomUUID()}, ${storeId}, ${v.catalogProductId}, ${v.shopifyVariantId}, ${v.shopifyProductId}, ${v.title}, ${v.sku}, ${v.position}, ${v.shopifyUpdatedAt}, ${syncJobId}, NULL, ${writtenAt})`,
    );
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "CatalogVariant" AS cv
        ("id", "storeId", "catalogProductId", "shopifyVariantId", "shopifyProductId", "title", "sku", "position",
         "shopifyUpdatedAt", "lastSeenSyncId", "removedFromShopifyAt", "updatedAt")
      VALUES ${Prisma.join(variantValues)}
      ON CONFLICT ("storeId", "shopifyVariantId") DO UPDATE SET
        "catalogProductId" = CASE WHEN (cv."sku" IS DISTINCT FROM EXCLUDED."sku" OR cv."title" <> EXCLUDED."title" OR cv."position" <> EXCLUDED."position" OR cv."removedFromShopifyAt" IS NOT NULL) THEN EXCLUDED."catalogProductId" ELSE cv."catalogProductId" END,
        "shopifyProductId" = CASE WHEN (cv."sku" IS DISTINCT FROM EXCLUDED."sku" OR cv."title" <> EXCLUDED."title" OR cv."position" <> EXCLUDED."position" OR cv."removedFromShopifyAt" IS NOT NULL) THEN EXCLUDED."shopifyProductId" ELSE cv."shopifyProductId" END,
        "title" = CASE WHEN (cv."sku" IS DISTINCT FROM EXCLUDED."sku" OR cv."title" <> EXCLUDED."title" OR cv."position" <> EXCLUDED."position" OR cv."removedFromShopifyAt" IS NOT NULL) THEN EXCLUDED."title" ELSE cv."title" END,
        "sku" = CASE WHEN (cv."sku" IS DISTINCT FROM EXCLUDED."sku" OR cv."title" <> EXCLUDED."title" OR cv."position" <> EXCLUDED."position" OR cv."removedFromShopifyAt" IS NOT NULL) THEN EXCLUDED."sku" ELSE cv."sku" END,
        "position" = CASE WHEN (cv."sku" IS DISTINCT FROM EXCLUDED."sku" OR cv."title" <> EXCLUDED."title" OR cv."position" <> EXCLUDED."position" OR cv."removedFromShopifyAt" IS NOT NULL) THEN EXCLUDED."position" ELSE cv."position" END,
        "shopifyUpdatedAt" = CASE WHEN (cv."sku" IS DISTINCT FROM EXCLUDED."sku" OR cv."title" <> EXCLUDED."title" OR cv."position" <> EXCLUDED."position" OR cv."removedFromShopifyAt" IS NOT NULL) THEN EXCLUDED."shopifyUpdatedAt" ELSE cv."shopifyUpdatedAt" END,
        "lastSeenSyncId" = EXCLUDED."lastSeenSyncId",
        "removedFromShopifyAt" = NULL,
        "updatedAt" = EXCLUDED."updatedAt"`);
  }

  return { variants: incoming.length };
}

/**
 * The underlying error of a failed ingest, safe to persist and to return to a caller:
 * connection strings and credential-looking values are removed, whitespace is collapsed
 * and the length is bounded.
 */
export function describeIngestError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted-url>")
    .replace(/\bnpg_[A-Za-z0-9]+/g, "<redacted>")
    .replace(/(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+/gi, "$1$2<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// ---------------------------------------------------------------------------
// 4. Removal detection
// ---------------------------------------------------------------------------

async function markRemovedProducts(prisma: PrismaClient, storeId: string, syncJobId: string, at: Date): Promise<number> {
  let removed = 0;
  for (;;) {
    const stale = await prisma.catalogProduct.findMany({
      where: { storeId, removedFromShopifyAt: null, NOT: { lastSeenSyncId: syncJobId } },
      select: { id: true },
      take: RECONCILE_BATCH_SIZE,
    });
    if (stale.length === 0) break;
    await prisma.catalogProduct.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { removedFromShopifyAt: at },
    });
    removed += stale.length;
    if (stale.length < RECONCILE_BATCH_SIZE) break;
  }
  return removed;
}

async function markRemovedVariants(prisma: PrismaClient, storeId: string, syncJobId: string, at: Date): Promise<number> {
  let removed = 0;
  for (;;) {
    const stale = await prisma.catalogVariant.findMany({
      where: { storeId, removedFromShopifyAt: null, NOT: { lastSeenSyncId: syncJobId } },
      select: { id: true },
      take: RECONCILE_BATCH_SIZE,
    });
    if (stale.length === 0) break;
    await prisma.catalogVariant.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { removedFromShopifyAt: at },
    });
    removed += stale.length;
    if (stale.length < RECONCILE_BATCH_SIZE) break;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function completeSync(
  prisma: PrismaClient,
  jobId: string,
  at: Date,
  extra: Partial<Prisma.CatalogSyncJobUncheckedUpdateInput> = {},
): Promise<SyncJobRow> {
  return finishSync(prisma, jobId, "completed", at, { errorCode: null, errorMessage: null, ...extra });
}

async function finishSync(
  prisma: PrismaClient,
  jobId: string,
  status: "completed" | "partial" | "failed",
  at: Date,
  extra: Partial<Prisma.CatalogSyncJobUncheckedUpdateInput> = {},
): Promise<SyncJobRow> {
  return prisma.catalogSyncJob.update({
    where: { id: jobId },
    data: {
      status,
      finishedAt: at,
      // Release the one-active-sync slot so the next synchronization can start.
      activeSentinel: null,
      leaseToken: null,
      leaseExpiresAt: null,
      ...extra,
    },
  });
}

async function failSync(
  prisma: PrismaClient,
  jobId: string,
  code: string,
  message: string,
  status: "failed" | "partial" = "failed",
): Promise<SyncJobRow> {
  return finishSync(prisma, jobId, status, new Date(), { errorCode: code, errorMessage: message.slice(0, 1000) });
}

function toState(job: SyncJobRow): CatalogSyncState {
  const terminal = ["completed", "partial", "failed", "superseded"].includes(job.status);
  // Task 6A.4B.1 — only `awaiting_bulk` (CREATED/RUNNING, nothing to ingest yet) backs
  // off; `ingesting` has real bounded work waiting and should be called back-to-back, same
  // as the assignment processor's batches.
  const retryAfterMs =
    !terminal && job.status === "awaiting_bulk"
      ? computeBulkPollBackoffMs(Date.now() - (job.startedAt ?? job.createdAt).getTime())
      : null;
  return {
    jobId: job.id,
    status: job.status,
    bulkOperationId: job.bulkOperationId,
    bulkOperationStatus: job.bulkOperationStatus,
    objectsSeen: job.objectsSeen,
    productsUpserted: job.productsUpserted,
    productsRemoved: job.productsRemoved,
    variantsSeen: job.variantsSeen,
    variantsUpserted: job.variantsUpserted,
    variantsRemoved: job.variantsRemoved,
    resumeByteOffset: job.resumeByteOffset,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    done: terminal,
    retryAfterMs,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function normalizeTags(v: unknown): string {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean).join(",");
}
function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
