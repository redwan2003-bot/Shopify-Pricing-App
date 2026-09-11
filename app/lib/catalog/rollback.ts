/**
 * Task 6A / 6A.1 — rollback of a completed / partially-completed bulk-assignment job.
 *
 * `planRollback` creates a NEW `BulkAssignmentJob` (`jobType: "rollback"`,
 * `rollbackOfJobId` set) and materializes one rollback item per product the original job
 * actually wrote. Each rollback item carries the ORIGINAL snapshot forward:
 *   - `prevPolicyJson` / `prevPolicyPresent` — the state to restore;
 *   - `prevPolicyDigest`                     — the digest that state had;
 *   - `postPolicyDigest`                     — the digest of what the ORIGINAL job wrote.
 *
 * CONFLICT SEMANTICS (6A.1)
 * `postPolicyDigest` is the compare-and-set token: a restore is only safe while Shopify's
 * current digest still equals it, i.e. nothing has touched the metafield since our write.
 *   - restoring a previous VALUE uses `metafieldsSet` with `compareDigest =
 *     postPolicyDigest` (a digest string), or `null` when the metafield is currently
 *     absent — NEVER `""`. Shopify rejects the write if anything changed;
 *   - restoring "previously absent" must use `metafieldsDelete`, which Shopify does NOT
 *     offer compare-and-set for. `write-port.ts#deleteProductPolicy` therefore re-reads
 *     the digest and refuses unless it still equals `postPolicyDigest`. The residual
 *     one-round-trip race is documented as an unavoidable platform limitation; a
 *     concurrently changed value is never deleted.
 *
 * TWO-SYSTEM ORDERING (Task 6A.1.1)
 *   - restore to a VALUE  → Shopify metafield first, THEN the local override, so a failed
 *     restore never leaves the override on the old profile while Shopify still holds this
 *     job's value;
 *   - restore to ABSENT   → remove the local override first (the product stops being
 *     dynamically priced), THEN delete the Shopify metafield.
 *
 * Scope: only the app-owned `ProductPricingOverride` + `$app:imprintid/pricing_policy`
 * metafield are ever touched. Store-scoped throughout. Refuses while enforcement is
 * enabled, re-checked before every batch.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ASSIGN_BATCH_SIZE, ASSIGN_BATCHES_PER_REQUEST, MAX_ITEM_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_MS } from "./constants.ts";
import { checkEnforcementDisabled } from "./enforcement-guard.ts";
import { normalizeExistingPolicyJson } from "./policy-value.ts";
import { loadOverridesByGid, overrideKeyValue, overrideWhereUnique } from "./override-store.ts";
import {
  acquireAssignmentLease,
  newWorkerToken,
  releaseAssignmentLease,
  renewAssignmentLease,
  LeaseGuard,
  LEASE_TTL_MS,
} from "./leases.ts";
import type { CatalogWritePort, PolicySetRequest } from "./write-port.ts";

export type PlanRollbackResult =
  | { ok: true; jobId: string; itemCount: number }
  | { ok: false; code: string; message: string };

export async function planRollback(
  prisma: PrismaClient,
  storeId: string,
  originalJobId: string,
  opts: { shopEnforcementPolicyJson: unknown; createdByUserId?: string | null },
): Promise<PlanRollbackResult> {
  const original = await prisma.bulkAssignmentJob.findFirst({ where: { id: originalJobId, storeId } });
  if (!original) return { ok: false, code: "JOB_NOT_FOUND", message: "no such job for this shop" };
  if (original.jobType !== "assign") return { ok: false, code: "NOT_AN_ASSIGNMENT", message: "only an assignment job can be rolled back" };
  if (!["completed", "partial", "failed"].includes(original.status)) {
    return { ok: false, code: "JOB_NOT_ROLLBACKABLE", message: `job status "${original.status}" cannot be rolled back` };
  }

  const gate = checkEnforcementDisabled(opts.shopEnforcementPolicyJson);
  if (!gate.ok) return { ok: false, code: `ENFORCEMENT_${gate.reason.toUpperCase()}`, message: gate.message };

  const existing = await prisma.bulkAssignmentJob.findFirst({
    where: { storeId, jobType: "rollback", rollbackOfJobId: originalJobId, status: { notIn: ["cancelled"] } },
  });
  if (existing) return { ok: true, jobId: existing.id, itemCount: existing.totalItems };

  // Only products the original job actually changed need restoring.
  const writtenItems = await prisma.bulkAssignmentItem.findMany({
    where: {
      jobId: originalJobId,
      storeId,
      OR: [{ overrideWritten: true }, { policyWritten: true }, { status: { in: ["succeeded", "unchanged"] } }],
    },
  });
  if (writtenItems.length === 0) return { ok: false, code: "NOTHING_TO_ROLL_BACK", message: "the job wrote nothing" };

  const job = await prisma.bulkAssignmentJob.create({
    data: {
      storeId,
      jobType: "rollback",
      status: "queued",
      idempotencyKey: `rollback:${originalJobId}`,
      createdByUserId: opts.createdByUserId ?? null,
      pricingProfileId: original.pricingProfileId,
      profileRevision: original.profileRevision,
      profileDigest: original.profileDigest,
      profileCurrency: original.profileCurrency,
      replaceExisting: original.replaceExisting,
      selectionKind: "rollback",
      selectionDescriptor: JSON.stringify({ kind: "rollback", of: originalJobId }),
      rollbackOfJobId: originalJobId,
      totalItems: writtenItems.length,
    },
  });

  const rows: Prisma.BulkAssignmentItemCreateManyInput[] = writtenItems.map((it) => ({
    storeId,
    jobId: job.id,
    shopifyProductId: it.shopifyProductId,
    catalogProductId: it.catalogProductId,
    status: "pending",
    // the ORIGINAL previous state — what we restore to
    prevOverrideExisted: it.prevOverrideExisted,
    prevOverrideProfileId: it.prevOverrideProfileId,
    prevOverrideBaseCents: it.prevOverrideBaseCents,
    prevOverrideActive: it.prevOverrideActive,
    prevPolicyJson: it.prevPolicyJson ?? "",
    prevPolicyPresent: it.prevPolicyPresent,
    prevPolicyDigest: it.prevPolicyDigest,
    // the digest of what the original job WROTE — the compare-and-set token
    postPolicyDigest: it.postPolicyDigest,
    newProfileId: it.newProfileId,
    newPolicyJson: it.newPolicyJson,
    idempotencyKey: randomUUID(),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await prisma.bulkAssignmentItem.createMany({ data: rows.slice(i, i + 500) });
  }

  await prisma.bulkAssignmentAudit.create({
    data: { storeId, jobId: job.id, event: "rollback_planned", detail: JSON.stringify({ of: originalJobId, itemCount: rows.length }) },
  });

  return { ok: true, jobId: job.id, itemCount: rows.length };
}

export interface RollbackDeps {
  port: CatalogWritePort;
  shopEnforcementPolicyJson: unknown;
  workerId?: string;
  now?: () => Date;
  /** restore even if the current Shopify state was changed by something else */
  force?: boolean;
  maxBatches?: number;
  leaseTtlMs?: number;
}

export interface RollbackResult {
  jobId: string;
  status: string;
  /** items this rollback actually WROTE back (metafield and/or override changed) */
  restored: number;
  /** Task 6A.3B §2 — items already at the restore target: ZERO writes. Counted
   * separately; never folded into `restored`/`succeeded`. */
  unchanged: number;
  conflicts: number;
  failed: number;
  remaining: number;
  batchesRun: number;
  more: boolean;
  refused?: { reason: string; message: string };
}

export async function processRollbackJob(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  deps: RollbackDeps,
): Promise<RollbackResult> {
  const now = deps.now ?? (() => new Date());
  const workerId = deps.workerId ?? newWorkerToken("rollback");
  const ttl = deps.leaseTtlMs ?? LEASE_TTL_MS;

  const job0 = await prisma.bulkAssignmentJob.findFirst({ where: { id: jobId, storeId, jobType: "rollback" } });
  if (!job0) throw new Error("rollback job not found for this store");
  if (["rolled_back", "completed", "cancelled"].includes(job0.status)) {
    return { ...(await rollupRollback(prisma, storeId, jobId, 0)), more: false };
  }

  const gate = checkEnforcementDisabled(deps.shopEnforcementPolicyJson);
  if (!gate.ok) {
    await prisma.bulkAssignmentJob.update({
      where: { id: jobId },
      data: { status: "paused", errorCode: `ENFORCEMENT_${gate.reason.toUpperCase()}`, errorMessage: gate.message },
    });
    return { ...(await rollupRollback(prisma, storeId, jobId, 0)), more: false, refused: { reason: gate.reason, message: gate.message } };
  }

  const lease = await acquireAssignmentLease(prisma, storeId, jobId, workerId, now(), ttl);
  if (!lease.acquired) {
    const r = await rollupRollback(prisma, storeId, jobId, 0);
    if (lease.reason === "terminal") return { ...r, more: false };
    return { ...r, more: true, refused: { reason: "busy", message: "another request is processing this rollback" } };
  }

  const guard = new LeaseGuard((at) => renewAssignmentLease(prisma, storeId, jobId, workerId, at, ttl), lease.expiresAt, now, ttl);
  let batchesRun = 0;

  try {
    await prisma.bulkAssignmentJob.update({
      where: { id: jobId },
      data: { status: "running", startedAt: job0.startedAt ?? now() },
    });

    const maxBatches = deps.maxBatches ?? ASSIGN_BATCHES_PER_REQUEST;
    while (batchesRun < maxBatches) {
      const perBatchGate = checkEnforcementDisabled(deps.shopEnforcementPolicyJson);
      if (!perBatchGate.ok) {
        await prisma.bulkAssignmentJob.update({
          where: { id: jobId },
          data: { status: "paused", errorCode: `ENFORCEMENT_${perBatchGate.reason.toUpperCase()}`, errorMessage: perBatchGate.message },
        });
        return {
          ...(await rollupRollback(prisma, storeId, jobId, batchesRun)),
          more: false,
          refused: { reason: perBatchGate.reason, message: perBatchGate.message },
        };
      }
      if (!(await guard.check())) break;

      const batch = await claimRollbackBatch(prisma, storeId, jobId, workerId, now(), ttl);
      if (batch.length === 0) break;
      batchesRun += 1;
      await restoreBatch(prisma, storeId, batch, deps.port, !!deps.force, now);
    }

    return finalizeRollback(prisma, storeId, jobId, batchesRun, now());
  } finally {
    await releaseAssignmentLease(prisma, storeId, jobId, workerId);
  }
}

interface RollbackItem {
  id: string;
  shopifyProductId: string;
  attemptCount: number;
  prevOverrideExisted: boolean;
  prevOverrideProfileId: string | null;
  prevOverrideBaseCents: number | null;
  prevOverrideActive: boolean | null;
  prevPolicyJson: string | null;
  prevPolicyPresent: boolean | null;
  postPolicyDigest: string | null;
  newProfileId: string;
  newPolicyJson: string;
}

async function claimRollbackBatch(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  workerId: string,
  now: Date,
  ttlMs: number,
): Promise<RollbackItem[]> {
  const claimable: Prisma.BulkAssignmentItemWhereInput = {
    jobId,
    storeId,
    OR: [
      { status: "pending", nextAttemptAt: null },
      { status: "pending", nextAttemptAt: { lte: now } },
      { status: "claimed", leaseExpiresAt: { lt: now } },
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
    select: {
      id: true, shopifyProductId: true, attemptCount: true,
      prevOverrideExisted: true, prevOverrideProfileId: true, prevOverrideBaseCents: true, prevOverrideActive: true,
      prevPolicyJson: true, prevPolicyPresent: true, postPolicyDigest: true, newProfileId: true, newPolicyJson: true,
    },
  });
}

async function restoreBatch(
  prisma: PrismaClient,
  storeId: string,
  items: RollbackItem[],
  port: CatalogWritePort,
  force: boolean,
  now: () => Date,
): Promise<void> {
  // ONE batched read of current Shopify state (value + compareDigest).
  let reads: Awaited<ReturnType<CatalogWritePort["readProductPolicies"]>>;
  try {
    reads = await port.readProductPolicies(items.map((i) => i.shopifyProductId));
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "policy read failed";
    for (const item of items) await retryOrFail(prisma, item, "TRANSIENT_POLICY_READ", message, item.attemptCount + 1);
    return;
  }

  const overrideByGid = await loadOverridesByGid(
    prisma,
    storeId,
    items.map((i) => i.shopifyProductId),
    { shopifyProductId: true, pricingProfileId: true, isActive: true },
  );

  const toSet: Array<{ item: RollbackItem; request: PolicySetRequest }> = [];
  const toDelete: RollbackItem[] = [];

  for (const item of items) {
    const attempt = item.attemptCount + 1;
    const read = reads.get(item.shopifyProductId);
    const currentJson = normalizeExistingPolicyJson(read?.jsonValue ?? null);
    const prevJson = item.prevPolicyJson ?? "";
    const prevPresent = item.prevPolicyPresent ?? prevJson !== "";

    const currentOverride = overrideByGid.get(item.shopifyProductId);
    const currentProfileId = currentOverride?.isActive ? (currentOverride.pricingProfileId ?? null) : null;
    const prevProfileId = item.prevOverrideExisted && item.prevOverrideActive ? (item.prevOverrideProfileId ?? null) : null;

    // Already fully at the target state → nothing to do.
    if (currentJson === prevJson && currentProfileId === prevProfileId) {
      await prisma.bulkAssignmentItem.update({
        where: { id: item.id },
        data: { status: "unchanged", attemptCount: attempt, errorCode: null, errorMessage: null, claimedBy: null, leaseExpiresAt: null },
      });
      continue;
    }

    // CONFLICT: Shopify's current state is neither what this job wrote nor what we would
    // restore. The compare-and-set token (`postPolicyDigest`) is the authority; the value
    // comparison is a defence-in-depth check for jobs recorded before digests existed.
    const digestMatches = item.postPolicyDigest != null && read?.compareDigest === item.postPolicyDigest;
    const valueMatches = currentJson === item.newPolicyJson || currentJson === prevJson;
    if (!force && !digestMatches && !valueMatches) {
      await conflict(prisma, item.id, attempt, "the product's pricing policy changed after this job wrote it — not restored");
      continue;
    }
    const overrideConflict = currentProfileId !== item.newProfileId && currentProfileId !== prevProfileId;
    if (!force && overrideConflict) {
      await conflict(prisma, item.id, attempt, "the product's pricing override changed after this job wrote it — not restored");
      continue;
    }

    if (!prevPresent || prevJson === "") {
      // Restore to ABSENT: remove the local override FIRST (the product stops being
      // dynamically priced), THEN delete the Shopify metafield.
      try {
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
      } catch (error) {
        await retryOrFail(prisma, item, "TRANSIENT_OVERRIDE_RESTORE", error instanceof Error ? error.message.slice(0, 300) : "override restore failed", attempt);
        continue;
      }
      toDelete.push(item);
    } else {
      // Restore to a previous VALUE: write the Shopify metafield FIRST (so a failed
      // restore does not leave the local override on the old profile while Shopify still
      // holds this job's value), THEN restore the local override.
      toSet.push({
        item,
        request: {
          productGid: item.shopifyProductId,
          valueJson: prevJson,
          // Normally compare against what THIS job wrote, so Shopify rejects the write if
          // anything touched the metafield since. `force` compares against what is there
          // RIGHT NOW instead — still compare-and-set. Fall back to `null` (assert absent)
          // when neither digest is known, i.e. the metafield is currently absent.
          compareDigest: force
            ? (read?.compareDigest ?? null)
            : (item.postPolicyDigest ?? read?.compareDigest ?? null),
        },
      });
    }
  }

  // ---- Restore a previous VALUE: metafield first, then override -----------------
  if (toSet.length > 0) {
    const outcomes = await port.setProductPolicies(toSet.map((t) => t.request));
    const at = now();
    for (const { item } of toSet) {
      const attempt = item.attemptCount + 1;
      const outcome = outcomes.get(item.shopifyProductId);
      if (!outcome) {
        await retryOrFail(prisma, item, "TRANSIENT_UNCONFIRMED_WRITE", "no result returned for this product", attempt);
        continue;
      }
      if (!outcome.ok) {
        if ("conflict" in outcome && outcome.conflict) {
          await conflict(prisma, item.id, attempt, outcome.message);
        } else {
          await retryOrFail(prisma, item, outcome.code, outcome.message, attempt, outcome.retryable);
        }
        continue;
      }

      // Metafield confirmed at the restored value — now restore the local override.
      try {
        if (item.prevOverrideExisted) {
          await prisma.productPricingOverride.upsert({
            where: overrideWhereUnique(storeId, item.shopifyProductId),
            create: {
              storeId,
              shopifyProductId: overrideKeyValue(item.shopifyProductId),
              pricingProfileId: item.prevOverrideProfileId,
              basePriceCents: item.prevOverrideBaseCents,
              isActive: item.prevOverrideActive ?? true,
            },
            update: {
              pricingProfileId: item.prevOverrideProfileId,
              basePriceCents: item.prevOverrideBaseCents,
              isActive: item.prevOverrideActive ?? true,
            },
          });
        } else {
          await prisma.productPricingOverride.deleteMany({ where: { storeId, shopifyProductId: overrideKeyValue(item.shopifyProductId) } });
        }
      } catch (error) {
        // Metafield restored, local override not — retryable. On resume the "already at
        // the target state" / conflict checks re-run against the now-restored metafield.
        await retryOrFail(prisma, item, "TRANSIENT_OVERRIDE_RESTORE", error instanceof Error ? error.message.slice(0, 300) : "override restore failed", attempt);
        continue;
      }

      await prisma.catalogProduct.updateMany({
        where: { storeId, shopifyProductId: item.shopifyProductId },
        data: {
          policySyncedAt: at,
          policyDigest: outcome.compareDigest ?? null,
          assignmentSource: item.prevOverrideExisted ? "override" : null,
        },
      });
      await prisma.bulkAssignmentItem.update({
        where: { id: item.id },
        data: { status: "rolled_back", attemptCount: attempt, errorCode: null, errorMessage: null, claimedBy: null, leaseExpiresAt: null, nextAttemptAt: null },
      });
    }
  }

  // ---- Restore to ABSENT: override already removed above; verify-then-delete ----
  for (const item of toDelete) {
    const attempt = item.attemptCount + 1;
    const outcome = force
      ? await port.deleteProductPolicy(item.shopifyProductId, (reads.get(item.shopifyProductId)?.compareDigest ?? null))
      : await port.deleteProductPolicy(item.shopifyProductId, item.postPolicyDigest);
    if (!outcome.ok) {
      if ("conflict" in outcome && outcome.conflict) {
        await conflict(prisma, item.id, attempt, outcome.message);
      } else {
        await retryOrFail(prisma, item, outcome.code, outcome.message, attempt, outcome.retryable);
      }
      continue;
    }
    await prisma.catalogProduct.updateMany({
      where: { storeId, shopifyProductId: item.shopifyProductId },
      data: { policySyncedAt: null, policyDigest: null, assignedProfileId: null, assignmentSource: null, coverageStatus: "unassigned", enforcementReady: false },
    });
    await prisma.bulkAssignmentItem.update({
      where: { id: item.id },
      data: { status: "rolled_back", attemptCount: attempt, errorCode: null, errorMessage: null, claimedBy: null, leaseExpiresAt: null, nextAttemptAt: null },
    });
  }
}

async function conflict(prisma: PrismaClient, id: string, attempt: number, message: string): Promise<void> {
  await prisma.bulkAssignmentItem.update({
    where: { id },
    data: { status: "failed", attemptCount: attempt, errorCode: "PERMANENT_ROLLBACK_CONFLICT", errorMessage: message, claimedBy: null, leaseExpiresAt: null },
  });
}

async function retryOrFail(
  prisma: PrismaClient,
  item: { id: string },
  code: string,
  message: string,
  attempt: number,
  retryable = true,
): Promise<void> {
  if (!retryable || attempt >= MAX_ITEM_ATTEMPTS) {
    await prisma.bulkAssignmentItem.update({
      where: { id: item.id },
      data: { status: "failed", attemptCount: attempt, errorCode: retryable ? "RETRY_EXHAUSTED" : code, errorMessage: message, claimedBy: null, leaseExpiresAt: null },
    });
    return;
  }
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  await prisma.bulkAssignmentItem.update({
    where: { id: item.id },
    data: { status: "pending", attemptCount: attempt, errorCode: code, errorMessage: message, nextAttemptAt: new Date(Date.now() + backoff), claimedBy: null, leaseExpiresAt: null },
  });
}

async function rollupRollback(prisma: PrismaClient, storeId: string, jobId: string, batchesRun: number): Promise<Omit<RollbackResult, "more">> {
  const [grouped, conflicts] = await Promise.all([
    prisma.bulkAssignmentItem.groupBy({ by: ["status"], where: { jobId, storeId }, _count: { _all: true } }),
    prisma.bulkAssignmentItem.count({ where: { jobId, storeId, status: "failed", errorCode: "PERMANENT_ROLLBACK_CONFLICT" } }),
  ]);
  const by = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  // Task 6A.3B §2 — a zero-write item (`unchanged`) is NOT a restore. Keep the two
  // counts distinct on the job row (`succeeded` = wrote-back, `unchanged` = no-op) and
  // in every downstream report.
  const restored = by("rolled_back");
  const unchanged = by("unchanged");
  const totalFailed = by("failed");
  const remaining = by("pending") + by("claimed") + by("overrideWritten");

  const job = await prisma.bulkAssignmentJob.update({
    where: { id: jobId },
    data: { succeeded: restored, unchanged, failed: totalFailed },
    select: { status: true },
  });
  return { jobId, status: job.status, restored, unchanged, conflicts, failed: totalFailed - conflicts, remaining, batchesRun };
}

async function finalizeRollback(prisma: PrismaClient, storeId: string, jobId: string, batchesRun: number, now: Date): Promise<RollbackResult> {
  const r = await rollupRollback(prisma, storeId, jobId, batchesRun);
  if (r.remaining > 0) {
    await prisma.bulkAssignmentJob.update({ where: { id: jobId }, data: { status: "running" } });
    return { ...r, status: "running", more: true };
  }
  const anyFailed = await prisma.bulkAssignmentItem.count({ where: { jobId, storeId, status: "failed" } });
  // A rollback that only ever found items already at the target state still completed —
  // it is `rolled_back` (a zero-write no-op), never `failed`. `failed` is reserved for
  // "every item errored".
  const status = anyFailed === 0 ? "rolled_back" : r.restored + r.unchanged === 0 ? "failed" : "partial";
  await prisma.bulkAssignmentJob.update({
    where: { id: jobId },
    data: {
      status,
      finishedAt: now,
      errorCode: status === "rolled_back" ? null : "ROLLBACK_INCOMPLETE",
      errorMessage: status === "rolled_back" ? null : `${anyFailed} item(s) not rolled back${r.conflicts ? ` (${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"})` : ""}`,
    },
  });
  await prisma.bulkAssignmentAudit.create({
    data: {
      storeId,
      jobId,
      event: "rollback_finished",
      detail: JSON.stringify({ status, restored: r.restored, unchanged: r.unchanged, conflicts: r.conflicts, failed: r.failed }),
    },
  });
  return { ...r, status, more: false };
}
