/**
 * Task 6A / 6A.1 — the durable, resumable, compare-and-set bulk-assignment processor.
 *
 * ONE INVOCATION = ONE BOUNDED UNIT OF WORK
 * `processAssignmentJob` claims an expiring lease on the job, runs at most
 * `maxBatches` batches of `ASSIGN_BATCH_SIZE` (25) products, persists progress after every
 * batch, releases the lease and returns. The Admin route calls it repeatedly. There are no
 * detached promises and no in-memory worker: closing the browser mid-run leaves a durable
 * job whose next request picks up exactly where the last one stopped.
 *
 * CONCURRENCY (6A.1)
 *   - Job level: an expiring lease (`leases.ts`) claimed with a guarded conditional
 *     UPDATE. Two simultaneous requests → exactly one acquires; the other is told the job
 *     is busy. A crashed worker's lease expires and the job is recoverable. Terminal jobs
 *     are never re-leased.
 *   - Item level: the same guarded-UPDATE pattern with a per-item `leaseExpiresAt`. The
 *     decision is `updateMany().count`, never a read-then-write, so the guarantee comes
 *     from the database's atomic row update rather than from SQLite's global write lock.
 *   - The lease is re-checked between batches; if it was stolen, the worker stops writing
 *     immediately.
 *
 * TWO-SYSTEM WRITE — SHOPIFY FIRST, THEN LOCAL (Task 6A.1.1)
 *   For each 25-product batch:
 *     1. one batched policy READ, capturing Shopify's `compareDigest`;
 *     2. snapshot persisted (once) so a crash keeps the rollback evidence;
 *     3. RECONCILE each item against the live read — already-current / safe-to-write /
 *        conflict — so a remote uncertainty is never blindly retried into an overwrite;
 *     4. ONE batched compare-and-set `metafieldsSet` (`compareDigest`: a digest string to
 *        replace, or literal `null` to assert absence — never `""`);
 *     5. ONLY for items whose metafield write Shopify CONFIRMED: write the local
 *        `ProductPricingOverride` (active) and stamp coverage.
 *
 *   INVARIANT: a product never becomes effectively dynamically priced through a local
 *   active override unless Shopify has confirmed the corresponding app-owned policy
 *   metafield. A CONFLICT, a permanent user error, an unattributable response, a
 *   network/unknown outcome, or a local DB failure after a remote success all leave the
 *   item fail-closed: not marked successful, and the local override reverted to its
 *   pre-job state if a legacy (override-first) attempt had written it.
 *
 * A digest mismatch is an explicit CONFLICT — never retried into an overwrite, never
 * reported as success.
 *
 * SAFETY GATES re-checked before EVERY batch: the job still belongs to this store, shop
 * enforcement is still provably disabled, and the target profile is still active,
 * currency-compatible and at the captured revision + content digest.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ASSIGN_BATCH_SIZE,
  ASSIGN_BATCHES_PER_REQUEST,
  ITEM_CLAIM_STALE_MS,
  MAX_ITEM_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
} from "./constants.ts";
import { checkEnforcementDisabled } from "./enforcement-guard.ts";
import { normalizeExistingPolicyJson } from "./policy-value.ts";
import { overrideKeyValue, overrideWhereUnique } from "./override-store.ts";
import { auditOverrideKeys, describeOverrideKeyConflict } from "./override-key-audit.ts";
import { resolveEnforceableCurrency } from "../pricing-api/currency-contract.ts";
import { revisionIdentityUnchanged } from "../pricing/revision.ts";
import {
  acquireAssignmentLease,
  newWorkerToken,
  releaseAssignmentLease,
  renewAssignmentLease,
  LeaseGuard,
  LEASE_TTL_MS,
} from "./leases.ts";
import type { CatalogWritePort, PolicySetRequest } from "./write-port.ts";

export interface ProcessDeps {
  port: CatalogWritePort;
  /** shop `$app:imprintid/enforcement_policy` metafield jsonValue (route fetches once). */
  shopEnforcementPolicyJson: unknown;
  workerId?: string;
  now?: () => Date;
  /** batches to run in THIS invocation (default `ASSIGN_BATCHES_PER_REQUEST`). */
  maxBatches?: number;
  leaseTtlMs?: number;
}

export interface ProcessResult {
  jobId: string;
  status: string;
  batchesRun: number;
  succeeded: number;
  unchanged: number;
  skipped: number;
  failed: number;
  conflicts: number;
  remaining: number;
  /** true when the caller should invoke `processAssignmentJob` again */
  more: boolean;
  refused?: { reason: string; message: string };
}

export async function processAssignmentJob(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  deps: ProcessDeps,
): Promise<ProcessResult> {
  const now = deps.now ?? (() => new Date());
  const workerId = deps.workerId ?? newWorkerToken("assign");
  const ttl = deps.leaseTtlMs ?? LEASE_TTL_MS;

  const job0 = await prisma.bulkAssignmentJob.findFirst({ where: { id: jobId, storeId } });
  if (!job0) throw new Error("bulk-assignment job not found for this store");
  if (job0.jobType !== "assign") throw new Error(`processAssignmentJob called for a ${job0.jobType} job`);
  if (["completed", "rolled_back", "cancelled"].includes(job0.status)) {
    return { ...(await summarize(prisma, storeId, jobId, 0)), more: false };
  }
  if (!["queued", "running", "paused", "partial", "failed"].includes(job0.status)) {
    throw new Error(`assignment job is "${job0.status}" — finish creating it with --apply before processing`);
  }

  // Gate BEFORE taking a lease: never even claim a job we may not run.
  const gate = checkEnforcementDisabled(deps.shopEnforcementPolicyJson);
  if (!gate.ok) {
    await prisma.bulkAssignmentJob.update({
      where: { id: jobId },
      data: { status: "paused", errorCode: `ENFORCEMENT_${gate.reason.toUpperCase()}`, errorMessage: gate.message },
    });
    await audit(prisma, storeId, jobId, "processor_refused", { reason: gate.reason });
    return { ...(await summarize(prisma, storeId, jobId, 0)), more: false, refused: { reason: gate.reason, message: gate.message } };
  }

  const lease = await acquireAssignmentLease(prisma, storeId, jobId, workerId, now(), ttl);
  if (!lease.acquired) {
    const s = await summarize(prisma, storeId, jobId, 0);
    if (lease.reason === "terminal") return { ...s, more: false };
    return { ...s, more: true, refused: { reason: "busy", message: "another request is processing this job" } };
  }

  const guard = new LeaseGuard((at) => renewAssignmentLease(prisma, storeId, jobId, workerId, at, ttl), lease.expiresAt, now, ttl);
  let batchesRun = 0;

  try {
    const job = await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: jobId, storeId } });
    const target = await resolveTargetProfile(prisma, storeId, job);

    await prisma.bulkAssignmentJob.update({
      where: { id: jobId },
      data: { status: "running", startedAt: job.startedAt ?? now(), errorCode: null, errorMessage: null },
    });
    await audit(prisma, storeId, jobId, "processing_started", { profileError: target.error });

    const maxBatches = deps.maxBatches ?? ASSIGN_BATCHES_PER_REQUEST;

    while (batchesRun < maxBatches) {
      // Re-check enforcement before EVERY batch — it may have been enabled mid-run.
      const perBatchGate = checkEnforcementDisabled(deps.shopEnforcementPolicyJson);
      if (!perBatchGate.ok) {
        await prisma.bulkAssignmentJob.update({
          where: { id: jobId },
          data: { status: "paused", errorCode: `ENFORCEMENT_${perBatchGate.reason.toUpperCase()}`, errorMessage: perBatchGate.message },
        });
        await audit(prisma, storeId, jobId, "processor_paused_enforcement", { reason: perBatchGate.reason, batchesRun });
        return {
          ...(await summarize(prisma, storeId, jobId, batchesRun)),
          more: false,
          refused: { reason: perBatchGate.reason, message: perBatchGate.message },
        };
      }
      if (!(await guard.check())) break; // lease lost — stop writing immediately

      const claimed = await claimBatch(prisma, storeId, jobId, workerId, now(), ttl);
      if (claimed.length === 0) break;
      batchesRun += 1;

      await processBatch(prisma, storeId, target, claimed, deps.port, now);
      await summarize(prisma, storeId, jobId, batchesRun);
    }

    return finalize(prisma, storeId, jobId, batchesRun, now());
  } finally {
    await releaseAssignmentLease(prisma, storeId, jobId, workerId);
  }
}

// ---------------------------------------------------------------------------
// target profile
// ---------------------------------------------------------------------------

interface TargetProfile {
  id: string;
  revision: number;
  /**
   * Task 6A.3B §3 — POLICY / OVERRIDE readiness ONLY: the profile is active,
   * currency-compatible and at the captured revision, so the app-owned policy metafield
   * and local override can be written. It does NOT mean checkout enforcement is live —
   * that is gated separately by the SHOP `enforcement_policy.enabled` flag, which the
   * assignment path requires to be `false`. A product marked `enforcementReady` is priced
   * normally at checkout until the shop enables enforcement.
   */
  enforcementReady: boolean;
  error: string | null;
}

async function resolveTargetProfile(
  prisma: PrismaClient,
  storeId: string,
  job: { pricingProfileId: string | null; profileRevision: number | null; profileDigest: string | null },
): Promise<TargetProfile> {
  const [profile, store] = await Promise.all([
    prisma.pricingProfile.findFirst({
      where: { id: job.pricingProfileId ?? "", storeId },
      select: { id: true, revision: true, contentDigest: true, currency: true, isActive: true },
    }),
    prisma.store.findUnique({ where: { id: storeId }, select: { shopCurrency: true } }),
  ]);

  if (!profile) return { id: job.pricingProfileId ?? "", revision: 0, enforcementReady: false, error: "PERMANENT_PROFILE_MISSING" };
  const currencyOk = resolveEnforceableCurrency(profile.currency, store?.shopCurrency ?? null).ok;
  if (!profile.isActive) return { id: profile.id, revision: profile.revision, enforcementReady: false, error: "PERMANENT_PROFILE_INACTIVE" };
  // Task 6A.1 — revision AND pricing-content digest must both still match what the dry
  // run captured, so a child-table edit that leaves `revision` alone is still caught.
  // Task 6A.3B §5 — a first-observation digest backfill (null → value, same revision) is
  // not a change.
  if (!revisionIdentityUnchanged(job.profileRevision, job.profileDigest, profile.revision, profile.contentDigest)) {
    return { id: profile.id, revision: profile.revision, enforcementReady: false, error: "PERMANENT_PROFILE_REVISION_CHANGED" };
  }
  if (!currencyOk) return { id: profile.id, revision: profile.revision, enforcementReady: false, error: "PERMANENT_CURRENCY_MISMATCH" };
  return { id: profile.id, revision: profile.revision, enforcementReady: true, error: null };
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

interface ClaimableItem {
  id: string;
  shopifyProductId: string;
  attemptCount: number;
  overrideWritten: boolean;
  policyWritten: boolean;
  prevPolicyJson: string | null;
  prevPolicyPresent: boolean | null;
  prevPolicyDigest: string | null;
  postPolicyDigest: string | null;
  prevOverrideExisted: boolean;
  prevOverrideProfileId: string | null;
  prevOverrideBaseCents: number | null;
  prevOverrideActive: boolean | null;
  newProfileId: string;
  newPolicyJson: string;
}

const CLAIM_SELECT = {
  id: true,
  shopifyProductId: true,
  attemptCount: true,
  overrideWritten: true,
  policyWritten: true,
  prevPolicyJson: true,
  prevPolicyPresent: true,
  prevPolicyDigest: true,
  postPolicyDigest: true,
  prevOverrideExisted: true,
  prevOverrideProfileId: true,
  prevOverrideBaseCents: true,
  prevOverrideActive: true,
  newProfileId: true,
  newPolicyJson: true,
} as const;

/**
 * Atomically claims up to `ASSIGN_BATCH_SIZE` items with an expiring per-item lease.
 *
 * Three statements, none of which is a read-then-write decision: pick candidates, take
 * them with a guarded conditional UPDATE (a racing worker's identical UPDATE matches zero
 * of the rows we just took), then read back only the rows whose `claimedBy` is us.
 */
async function claimBatch(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  workerId: string,
  now: Date,
  ttlMs: number,
): Promise<ClaimableItem[]> {
  const legacyStale = new Date(now.getTime() - ITEM_CLAIM_STALE_MS);
  const claimable: Prisma.BulkAssignmentItemWhereInput = {
    jobId,
    storeId,
    OR: [
      { status: "pending", nextAttemptAt: null },
      { status: "pending", nextAttemptAt: { lte: now } },
      { status: "overrideWritten", nextAttemptAt: null },
      { status: "overrideWritten", nextAttemptAt: { lte: now } },
      // an expired item lease (crashed worker)
      { status: "claimed", leaseExpiresAt: { lt: now } },
      // belt-and-braces for rows written before item leases existed
      { status: "claimed", leaseExpiresAt: null, claimedAt: { lt: legacyStale } },
    ],
  };

  const candidates = await prisma.bulkAssignmentItem.findMany({
    where: claimable,
    orderBy: { id: "asc" },
    take: ASSIGN_BATCH_SIZE,
    select: { id: true },
  });
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.id);

  await prisma.bulkAssignmentItem.updateMany({
    where: { id: { in: ids }, ...claimable },
    data: { status: "claimed", claimedBy: workerId, claimedAt: now, leaseExpiresAt: new Date(now.getTime() + ttlMs) },
  });

  return prisma.bulkAssignmentItem.findMany({
    where: { id: { in: ids }, storeId, jobId, status: "claimed", claimedBy: workerId },
    select: CLAIM_SELECT,
  });
}

// ---------------------------------------------------------------------------
// batch processing — one read round-trip, one write round-trip
// ---------------------------------------------------------------------------

async function processBatch(
  prisma: PrismaClient,
  storeId: string,
  target: TargetProfile,
  items: ClaimableItem[],
  port: CatalogWritePort,
  now: () => Date,
): Promise<void> {
  // A permanently invalid target fails the whole batch without touching Shopify.
  if (target.error) {
    for (const item of items) {
      await permanentFail(prisma, item.id, target.error, "the target pricing profile is no longer valid", item.attemptCount + 1);
    }
    return;
  }

  // Batch-fetch catalog rows: the store-scope + still-present check.
  const catalogRows = await prisma.catalogProduct.findMany({
    where: { storeId, shopifyProductId: { in: items.map((i) => i.shopifyProductId) } },
    select: { shopifyProductId: true, removedFromShopifyAt: true },
  });
  const catalogByGid = new Map(catalogRows.map((r) => [r.shopifyProductId, r]));

  const live: ClaimableItem[] = [];
  for (const item of items) {
    const row = catalogByGid.get(item.shopifyProductId);
    if (!row || row.removedFromShopifyAt) {
      await permanentFail(prisma, item.id, "PERMANENT_PRODUCT_MISSING", "product is no longer in this store's catalog", item.attemptCount + 1);
      continue;
    }
    live.push(item);
  }
  if (live.length === 0) return;

  // Task 6A.3B §4 — fail closed on a product whose legacy GID-keyed override disagrees
  // with the bare-keyed one: its effective price is ambiguous, so we must not write it.
  const keyAudit = await auditOverrideKeys(prisma, storeId, live.map((i) => i.shopifyProductId));
  if (keyAudit.blockedGids.size > 0) {
    const conflictMsg = new Map(keyAudit.conflicts.map((c) => [c.productGid, describeOverrideKeyConflict(c)]));
    for (let i = live.length - 1; i >= 0; i--) {
      const gid = live[i]!.shopifyProductId;
      if (!keyAudit.blockedGids.has(gid)) continue;
      await permanentFail(prisma, live[i]!.id, "PERMANENT_OVERRIDE_KEY_CONFLICT", conflictMsg.get(gid) ?? "conflicting legacy override record", live[i]!.attemptCount + 1);
      live.splice(i, 1);
    }
  }
  if (live.length === 0) return;

  // ---- 1. ONE batched policy read, capturing Shopify's compareDigest -------------
  let reads: Awaited<ReturnType<CatalogWritePort["readProductPolicies"]>>;
  try {
    reads = await port.readProductPolicies(live.map((i) => i.shopifyProductId));
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "policy read failed";
    for (const item of live) await scheduleRetryOrFail(prisma, item, "TRANSIENT_POLICY_READ", message, item.attemptCount + 1);
    return;
  }

  // ---- 2. Persist the snapshot (once) + reconcile each item against the live read ---
  // `toWrite`      — items that need a compare-and-set metafield write, with the exact
  //                  `compareDigest` to send (a digest string, or `null` for absence).
  // `needOverride` — items whose metafield is already CONFIRMED at the desired value
  //                  (our earlier write landed, or it was already correct): only the
  //                  local override + coverage stamp remain.
  const toWrite: Array<{ item: ClaimableItem; compareDigest: string | null }> = [];
  const needOverride: Array<{ item: ClaimableItem; postDigest: string | null }> = [];

  for (const item of live) {
    const read = reads.get(item.shopifyProductId);

    // Capture the pre-write snapshot exactly once (first attempt).
    if (item.prevPolicyJson === null) {
      const prevJson = normalizeExistingPolicyJson(read?.jsonValue ?? null);
      const prevPresent = read?.present ?? false;
      const prevDigest = read?.compareDigest ?? null;
      await prisma.bulkAssignmentItem.update({
        where: { id: item.id },
        data: {
          prevPolicyJson: prevJson,
          prevPolicyPresent: prevPresent,
          prevPolicyDigest: prevDigest,
          prevPolicyMetafieldId: read?.metafieldId ?? null,
        },
      });
      item.prevPolicyJson = prevJson;
      item.prevPolicyPresent = prevPresent;
      item.prevPolicyDigest = prevDigest;
    }

    // An earlier attempt already got Shopify's confirmation — trust it, finish the local
    // half. (A later third-party change is the rollback path's concern, not this one's.)
    if (item.policyWritten) {
      needOverride.push({ item, postDigest: item.postPolicyDigest });
      continue;
    }

    // Already fully at the desired state before this job ran → unchanged, no writes.
    const currentJson = normalizeExistingPolicyJson(read?.jsonValue ?? null);
    const wasAtDesiredProfile =
      item.prevOverrideExisted && item.prevOverrideActive === true && item.prevOverrideProfileId === target.id;
    if (wasAtDesiredProfile && currentJson === item.newPolicyJson && !item.overrideWritten) {
      // No write is needed, but the processor DID just verify (via the live read) that
      // the app-owned policy metafield is present and exactly the desired value AND that
      // the local override already pins this product to the target profile. Record that
      // verified-consistent state on the denormalized catalog row so the coverage display
      // reflects reality — otherwise a product that was assigned outside this subsystem
      // (e.g. by the provisioner's pilot preparation) keeps showing "unassigned".
      // This touches ONLY `CatalogProduct` — never Shopify, never `ProductPricingOverride`.
      await prisma.catalogProduct.updateMany({
        where: { storeId, shopifyProductId: item.shopifyProductId },
        data: {
          assignedProfileId: target.id,
          assignmentSource: "override",
          policySyncedAt: now(),
          policyDigest: read?.compareDigest ?? null,
          coverageStatus: "assigned",
          enforcementReady: target.enforcementReady,
        },
      });
      await markItem(prisma, item.id, "unchanged", item.attemptCount + 1, { overrideWritten: false, policyWritten: false });
      continue;
    }

    // RECONCILE — never blindly retry a remote uncertainty into an overwrite.
    const decision = reconcilePolicyWrite(item, read, item.newPolicyJson);
    if (decision.action === "conflict") {
      // Metafield NOT written; local override NOT written (Shopify-first). If a legacy
      // (override-first) attempt had already written the override, revert it so the
      // product does not stay effectively dynamically priced without a confirmed policy.
      if (item.overrideWritten) await undoLocalOverride(prisma, storeId, item);
      await permanentFail(prisma, item.id, "PERMANENT_POLICY_CONFLICT", decision.message, item.attemptCount + 1);
      continue;
    }
    if (decision.action === "already-current") {
      // Shopify already holds exactly our desired value — adopt its digest, no write.
      await prisma.bulkAssignmentItem.update({
        where: { id: item.id },
        data: { policyWritten: true, postPolicyDigest: decision.digest },
      });
      item.policyWritten = true;
      item.postPolicyDigest = decision.digest;
      needOverride.push({ item, postDigest: decision.digest });
      continue;
    }
    toWrite.push({ item, compareDigest: decision.compareDigest });
  }

  // ---- 3. ONE batched compare-and-set metafieldsSet -----------------------------
  if (toWrite.length > 0) {
    const requests: PolicySetRequest[] = toWrite.map((w) => ({
      productGid: w.item.shopifyProductId,
      valueJson: w.item.newPolicyJson,
      compareDigest: w.compareDigest, // string → replace, null → assert absent (never "")
    }));
    const outcomes = await port.setProductPolicies(requests);

    for (const { item } of toWrite) {
      const attempt = item.attemptCount + 1;
      const outcome = outcomes.get(item.shopifyProductId);

      // Remote uncertainty (no result / unattributable / network / unknown) — NOT
      // written, NOT retried into an overwrite here. Retryable: the next attempt
      // re-reads + reconciles this exact item.
      if (!outcome) {
        if (item.overrideWritten) await undoLocalOverride(prisma, storeId, item);
        await scheduleRetryOrFail(prisma, item, "TRANSIENT_UNCONFIRMED_WRITE", "no result returned for this product", attempt);
        continue;
      }
      if (!outcome.ok) {
        if ("conflict" in outcome && outcome.conflict) {
          if (item.overrideWritten) await undoLocalOverride(prisma, storeId, item);
          await permanentFail(prisma, item.id, "PERMANENT_POLICY_CONFLICT", outcome.message, attempt);
          continue;
        }
        // retryable transient OR permanent user error — either way, no override written.
        if (item.overrideWritten) await undoLocalOverride(prisma, storeId, item);
        await scheduleRetryOrFail(prisma, item, outcome.code, outcome.message, attempt, outcome.retryable);
        continue;
      }

      // CONFIRMED. Persist the confirmation BEFORE the override write, so a crash between
      // the two resumes into the `item.policyWritten` branch above and only redoes the
      // local half.
      await prisma.bulkAssignmentItem.update({
        where: { id: item.id },
        data: { policyWritten: true, postPolicyDigest: outcome.compareDigest ?? null },
      });
      item.policyWritten = true;
      item.postPolicyDigest = outcome.compareDigest ?? null;
      needOverride.push({ item, postDigest: outcome.compareDigest ?? null });
    }
  }

  // ---- 4. Local override + coverage stamp — ONLY for CONFIRMED metafields --------
  const at = now();
  for (const { item, postDigest } of needOverride) {
    const attempt = item.attemptCount + 1;
    try {
      if (!item.overrideWritten) {
        await prisma.productPricingOverride.upsert({
          where: overrideWhereUnique(storeId, item.shopifyProductId),
          create: { storeId, shopifyProductId: overrideKeyValue(item.shopifyProductId), pricingProfileId: target.id, isActive: true },
          update: { pricingProfileId: target.id, isActive: true },
        });
        item.overrideWritten = true;
      }
    } catch (error) {
      // Local DB failure AFTER a confirmed remote write. The metafield is confirmed, so
      // this is retryable: on resume, `item.policyWritten` is true → step 2 routes
      // straight back here. The item is NOT marked successful.
      await scheduleRetryOrFail(
        prisma,
        item,
        "TRANSIENT_OVERRIDE_WRITE",
        error instanceof Error ? error.message.slice(0, 300) : "override write failed",
        attempt,
      );
      continue;
    }

    await prisma.catalogProduct.updateMany({
      where: { storeId, shopifyProductId: item.shopifyProductId },
      data: {
        policySyncedAt: at,
        policyDigest: postDigest,
        assignedProfileId: target.id,
        assignmentSource: "bulk",
        coverageStatus: "assigned",
        enforcementReady: target.enforcementReady,
      },
    });
    await prisma.bulkAssignmentItem.update({
      where: { id: item.id },
      data: {
        status: "succeeded",
        attemptCount: attempt,
        overrideWritten: true,
        policyWritten: true,
        postPolicyDigest: postDigest,
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// reconcile + local-override revert
// ---------------------------------------------------------------------------

type PolicyReconcile =
  | { action: "already-current"; digest: string | null }
  | { action: "write"; compareDigest: string | null }
  | { action: "conflict"; message: string };

/**
 * Decides how to bring one product's app-owned metafield to `desiredJson`, given the
 * LIVE read and the snapshot captured on the first attempt.
 *
 *   - the metafield already equals the desired value  → `already-current` (adopt, no write);
 *   - the live state is EXACTLY the snapshot we captured (nothing moved underneath us)
 *     → `write` with `compareDigest` = the snapshot digest, or `null` if it was absent;
 *   - anything else (a third party changed it to some other value)  → `conflict`.
 *
 * This is the "re-read and reconcile before any retry write" rule: a `TRANSIENT_*`
 * outcome brings the item back here, and only a live state matching our snapshot is
 * written — a mismatch is a conflict, never a blind overwrite.
 */
function reconcilePolicyWrite(
  item: Pick<ClaimableItem, "prevPolicyPresent" | "prevPolicyDigest">,
  read: { present: boolean; jsonValue: unknown; compareDigest: string | null } | undefined,
  desiredJson: string,
): PolicyReconcile {
  const currentJson = normalizeExistingPolicyJson(read?.jsonValue ?? null);
  const currentPresent = read?.present ?? false;
  const currentDigest = read?.compareDigest ?? null;

  if (currentJson === desiredJson) {
    return { action: "already-current", digest: currentDigest };
  }

  const expectedPresent = item.prevPolicyPresent ?? false;
  const expectedDigest = expectedPresent ? item.prevPolicyDigest : null;
  if (currentPresent === expectedPresent && currentDigest === expectedDigest) {
    return { action: "write", compareDigest: expectedDigest };
  }

  return {
    action: "conflict",
    message: "the product's pricing policy changed since it was read — not overwritten",
  };
}

/**
 * Reverts a local `ProductPricingOverride` to its pre-job state. Used when a metafield
 * write fails but a LEGACY (override-first) attempt had already written the override —
 * so the product does not stay effectively dynamically priced without a confirmed policy.
 * Current (Shopify-first) attempts never write the override before confirmation, so this
 * only ever runs for rows created by the old ordering.
 */
async function undoLocalOverride(prisma: PrismaClient, storeId: string, item: ClaimableItem): Promise<void> {
  if (item.prevOverrideExisted) {
    await prisma.productPricingOverride.upsert({
      where: overrideWhereUnique(storeId, item.shopifyProductId),
      create: {
        storeId,
        shopifyProductId: overrideKeyValue(item.shopifyProductId),
        pricingProfileId: item.prevOverrideProfileId,
        basePriceCents: item.prevOverrideBaseCents,
        isActive: item.prevOverrideActive ?? false,
      },
      update: {
        pricingProfileId: item.prevOverrideProfileId,
        basePriceCents: item.prevOverrideBaseCents,
        isActive: item.prevOverrideActive ?? false,
      },
    });
  } else {
    await prisma.productPricingOverride.deleteMany({ where: { storeId, shopifyProductId: overrideKeyValue(item.shopifyProductId) } });
  }
  await prisma.catalogProduct.updateMany({
    where: { storeId, shopifyProductId: item.shopifyProductId },
    data: { assignedProfileId: null, assignmentSource: null, coverageStatus: "unassigned", enforcementReady: false, policySyncedAt: null, policyDigest: null },
  });
  await prisma.bulkAssignmentItem.update({ where: { id: item.id }, data: { overrideWritten: false } });
  item.overrideWritten = false;
}

// ---------------------------------------------------------------------------
// item state helpers
// ---------------------------------------------------------------------------

async function markItem(
  prisma: PrismaClient,
  id: string,
  status: "succeeded" | "unchanged",
  attempt: number,
  flags: { overrideWritten: boolean; policyWritten: boolean },
): Promise<void> {
  await prisma.bulkAssignmentItem.update({
    where: { id },
    data: {
      status,
      attemptCount: attempt,
      overrideWritten: flags.overrideWritten,
      policyWritten: flags.policyWritten,
      errorCode: null,
      errorMessage: null,
      nextAttemptAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
    },
  });
}

async function permanentFail(prisma: PrismaClient, id: string, code: string, message: string, attempt: number): Promise<void> {
  await prisma.bulkAssignmentItem.update({
    where: { id },
    data: { status: "failed", attemptCount: attempt, errorCode: code, errorMessage: message, claimedBy: null, leaseExpiresAt: null, nextAttemptAt: null },
  });
}

/** Retries a transient failure with bounded exponential backoff; a permanent one, or an
 * exhausted retry budget, becomes `failed`. Retry counters live in the row, so the limit
 * survives a process restart. */
async function scheduleRetryOrFail(
  prisma: PrismaClient,
  item: { id: string; overrideWritten: boolean },
  code: string,
  message: string,
  attempt: number,
  retryable = true,
): Promise<void> {
  if (!retryable) {
    await prisma.bulkAssignmentItem.update({
      where: { id: item.id },
      data: { status: "failed", attemptCount: attempt, overrideWritten: item.overrideWritten, errorCode: code, errorMessage: message, claimedBy: null, leaseExpiresAt: null },
    });
    return;
  }
  if (attempt >= MAX_ITEM_ATTEMPTS) {
    await prisma.bulkAssignmentItem.update({
      where: { id: item.id },
      data: { status: "failed", attemptCount: attempt, overrideWritten: item.overrideWritten, errorCode: "RETRY_EXHAUSTED", errorMessage: message, claimedBy: null, leaseExpiresAt: null },
    });
    return;
  }
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  await prisma.bulkAssignmentItem.update({
    where: { id: item.id },
    data: {
      status: item.overrideWritten ? "overrideWritten" : "pending",
      overrideWritten: item.overrideWritten,
      attemptCount: attempt,
      errorCode: code,
      errorMessage: message,
      nextAttemptAt: new Date(Date.now() + backoff),
      claimedBy: null,
      leaseExpiresAt: null,
    },
  });
}

// ---------------------------------------------------------------------------
// roll-up
// ---------------------------------------------------------------------------

async function summarize(prisma: PrismaClient, storeId: string, jobId: string, batchesRun: number): Promise<Omit<ProcessResult, "more">> {
  const [grouped, conflicts] = await Promise.all([
    prisma.bulkAssignmentItem.groupBy({ by: ["status"], where: { jobId, storeId }, _count: { _all: true } }),
    prisma.bulkAssignmentItem.count({ where: { jobId, storeId, status: "failed", errorCode: "PERMANENT_POLICY_CONFLICT" } }),
  ]);
  const by = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const succeeded = by("succeeded");
  const unchanged = by("unchanged");
  const skipped = by("skipped");
  const failed = by("failed");
  const remaining = by("pending") + by("claimed") + by("overrideWritten");

  const job = await prisma.bulkAssignmentJob.update({
    where: { id: jobId },
    data: { succeeded, unchanged, skipped, failed },
    select: { status: true },
  });
  return { jobId, status: job.status, batchesRun, succeeded, unchanged, skipped, failed, conflicts, remaining };
}

async function finalize(prisma: PrismaClient, storeId: string, jobId: string, batchesRun: number, now: Date): Promise<ProcessResult> {
  const s = await summarize(prisma, storeId, jobId, batchesRun);
  if (s.remaining > 0) {
    // More work waiting: this invocation hit its batch cap, or retries are backing off.
    await prisma.bulkAssignmentJob.update({ where: { id: jobId }, data: { status: "running" } });
    await audit(prisma, storeId, jobId, "processing_yielded", { remaining: s.remaining, batchesRun });
    return { ...s, status: "running", more: true };
  }

  const done = s.succeeded + s.unchanged;
  const status = s.failed === 0 ? "completed" : done === 0 ? "failed" : "partial";
  await prisma.bulkAssignmentJob.update({
    where: { id: jobId },
    data: {
      status,
      finishedAt: now,
      errorCode: status === "completed" ? null : "ITEMS_FAILED",
      errorMessage: status === "completed" ? null : `${s.failed} item(s) failed${s.conflicts ? `, ${s.conflicts} of them conflicts` : ""}`,
    },
  });
  await audit(prisma, storeId, jobId, "processing_finished", {
    status, succeeded: s.succeeded, unchanged: s.unchanged, failed: s.failed, conflicts: s.conflicts,
  });
  return { ...s, status, more: false };
}

async function audit(prisma: PrismaClient, storeId: string, jobId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  await prisma.bulkAssignmentAudit.create({ data: { storeId, jobId, event, detail: JSON.stringify(detail) } });
}

// ---------------------------------------------------------------------------
// retry / resume entry points
// ---------------------------------------------------------------------------

/** Re-queues a job's retryable failed items. A `PERMANENT_*` code — including a
 * compare-and-set conflict — is never auto-retried. */
export async function requeueFailedItems(prisma: PrismaClient, storeId: string, jobId: string): Promise<{ requeued: number; permanent: number }> {
  const job = await prisma.bulkAssignmentJob.findFirst({ where: { id: jobId, storeId } });
  if (!job) throw new Error("job not found for this store");
  const failed = await prisma.bulkAssignmentItem.findMany({
    where: { jobId, storeId, status: "failed" },
    select: { id: true, errorCode: true },
  });
  const retryable = failed.filter((f) => !f.errorCode || !f.errorCode.startsWith("PERMANENT_"));
  const permanent = failed.length - retryable.length;
  if (retryable.length === 0) return { requeued: 0, permanent };

  await prisma.bulkAssignmentItem.updateMany({
    where: { id: { in: retryable.map((r) => r.id) } },
    data: { status: "pending", attemptCount: 0, nextAttemptAt: null, errorCode: null, errorMessage: null, claimedBy: null, claimedAt: null, leaseExpiresAt: null },
  });
  await prisma.bulkAssignmentJob.update({ where: { id: jobId }, data: { status: "running", finishedAt: null } });
  await audit(prisma, storeId, jobId, "retry_requested", { requeued: retryable.length, permanent });
  return { requeued: retryable.length, permanent };
}

/** Clears an expired job lease so an interrupted job can be resumed. Never steals a live
 * lease and never revives a terminal job. */
export async function resumeInterruptedJob(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<{ resumed: boolean; reason?: string }> {
  const job = await prisma.bulkAssignmentJob.findFirst({ where: { id: jobId, storeId } });
  if (!job) throw new Error("job not found for this store");
  if (["completed", "rolled_back", "cancelled"].includes(job.status)) return { resumed: false, reason: "job is finished" };
  if (job.workerToken && job.leaseExpiresAt && job.leaseExpiresAt > now) {
    return { resumed: false, reason: "another request is actively processing this job" };
  }
  await prisma.bulkAssignmentJob.update({
    where: { id: jobId },
    data: { workerToken: null, leaseExpiresAt: null, status: "running", errorCode: null, errorMessage: null, finishedAt: null },
  });
  // Release any item leases that outlived their worker.
  await prisma.bulkAssignmentItem.updateMany({
    where: { jobId, storeId, status: "claimed", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
    data: { status: "pending", claimedBy: null, leaseExpiresAt: null },
  });
  await audit(prisma, storeId, jobId, "resume_requested", {});
  return { resumed: true };
}
