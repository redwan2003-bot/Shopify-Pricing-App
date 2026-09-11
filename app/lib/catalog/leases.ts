/**
 * Task 6A.1 — expiring worker leases for catalog sync and bulk-assignment jobs.
 *
 * WHY NOT "SQLITE SERIALIZES WRITES"
 * The 6A processor relied on the fact that SQLite takes a global write lock, so two
 * `updateMany` claims could not interleave. That is a property of one deployment target,
 * not of the data model — on Postgres/MySQL the same code would race. Everything here is
 * expressed as a guarded conditional UPDATE whose WHERE clause contains the entire
 * precondition, so the database's own atomic row update is the concurrency primitive:
 *
 *     UPDATE … SET leaseToken = :me, leaseExpiresAt = :now+ttl
 *      WHERE id = :id
 *        AND status NOT IN (terminal…)
 *        AND (leaseToken IS NULL OR leaseExpiresAt < :now OR leaseToken = :me)
 *
 * The update either affects 1 row (we own the lease) or 0 rows (someone else does).
 * `updateMany().count` is the decision — never a read-then-write.
 *
 * Leases EXPIRE, so a worker that crashes mid-batch does not wedge the job: the next
 * bounded request finds `leaseExpiresAt < now` and takes over. A worker that is still
 * alive renews (`renewLease`) so a long batch is not stolen from underneath it.
 * Terminal jobs are never leasable.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** How long a claim is valid without renewal. Sized well above one bounded batch. */
export const LEASE_TTL_MS = 60_000;
/** Renew once a lease is within this of expiry. */
export const LEASE_RENEW_BEFORE_MS = 20_000;

/** Statuses from which a job may never be re-leased. */
export const TERMINAL_SYNC_STATUSES = ["completed", "partial", "failed", "superseded"] as const;
export const TERMINAL_ASSIGNMENT_STATUSES = ["completed", "partial", "failed", "rolled_back", "cancelled"] as const;

export function newWorkerToken(prefix = "w"): string {
  return `${prefix}_${randomUUID()}`;
}

export type LeaseResult =
  | { acquired: true; token: string; expiresAt: Date }
  | { acquired: false; reason: "held_by_other" | "terminal" | "not_found" };

// ---------------------------------------------------------------------------
// Bulk assignment / rollback jobs
// ---------------------------------------------------------------------------

/**
 * Atomically claims a bulk-assignment job. Succeeds when the job exists for this store,
 * is not terminal, and is either unleased, expired, or already ours.
 */
export async function acquireAssignmentLease(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  token: string,
  now: Date = new Date(),
  ttlMs: number = LEASE_TTL_MS,
): Promise<LeaseResult> {
  const expiresAt = new Date(now.getTime() + ttlMs);
  const res = await prisma.bulkAssignmentJob.updateMany({
    where: {
      id: jobId,
      storeId,
      status: { notIn: [...TERMINAL_ASSIGNMENT_STATUSES] },
      OR: [{ workerToken: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }, { workerToken: token }],
    },
    data: { workerToken: token, workerClaimedAt: now, leaseExpiresAt: expiresAt },
  });
  if (res.count === 1) return { acquired: true, token, expiresAt };

  const job = await prisma.bulkAssignmentJob.findFirst({
    where: { id: jobId, storeId },
    select: { status: true },
  });
  if (!job) return { acquired: false, reason: "not_found" };
  if ((TERMINAL_ASSIGNMENT_STATUSES as readonly string[]).includes(job.status)) {
    return { acquired: false, reason: "terminal" };
  }
  return { acquired: false, reason: "held_by_other" };
}

/** Extends our lease. Returns false if we no longer hold it (someone took over) — the
 * caller must stop writing immediately. */
export async function renewAssignmentLease(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  token: string,
  now: Date = new Date(),
  ttlMs: number = LEASE_TTL_MS,
): Promise<boolean> {
  const res = await prisma.bulkAssignmentJob.updateMany({
    where: { id: jobId, storeId, workerToken: token },
    data: { leaseExpiresAt: new Date(now.getTime() + ttlMs) },
  });
  return res.count === 1;
}

/** Releases our lease so the next request can take over immediately. */
export async function releaseAssignmentLease(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  token: string,
): Promise<void> {
  await prisma.bulkAssignmentJob.updateMany({
    where: { id: jobId, storeId, workerToken: token },
    data: { workerToken: null, leaseExpiresAt: null },
  });
}

// ---------------------------------------------------------------------------
// Catalog sync jobs
// ---------------------------------------------------------------------------

export async function acquireSyncLease(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  token: string,
  now: Date = new Date(),
  ttlMs: number = LEASE_TTL_MS,
): Promise<LeaseResult> {
  const expiresAt = new Date(now.getTime() + ttlMs);
  const res = await prisma.catalogSyncJob.updateMany({
    where: {
      id: jobId,
      storeId,
      status: { notIn: [...TERMINAL_SYNC_STATUSES] },
      OR: [{ leaseToken: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }, { leaseToken: token }],
    },
    data: { leaseToken: token, leaseExpiresAt: expiresAt },
  });
  if (res.count === 1) return { acquired: true, token, expiresAt };

  const job = await prisma.catalogSyncJob.findFirst({ where: { id: jobId, storeId }, select: { status: true } });
  if (!job) return { acquired: false, reason: "not_found" };
  if ((TERMINAL_SYNC_STATUSES as readonly string[]).includes(job.status)) return { acquired: false, reason: "terminal" };
  return { acquired: false, reason: "held_by_other" };
}

export async function renewSyncLease(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  token: string,
  now: Date = new Date(),
  ttlMs: number = LEASE_TTL_MS,
): Promise<boolean> {
  const res = await prisma.catalogSyncJob.updateMany({
    where: { id: jobId, storeId, leaseToken: token },
    data: { leaseExpiresAt: new Date(now.getTime() + ttlMs) },
  });
  return res.count === 1;
}

export async function releaseSyncLease(
  prisma: PrismaClient,
  storeId: string,
  jobId: string,
  token: string,
): Promise<void> {
  await prisma.catalogSyncJob.updateMany({
    where: { id: jobId, storeId, leaseToken: token },
    data: { leaseToken: null, leaseExpiresAt: null },
  });
}

/**
 * A lease held for the duration of one bounded unit of work, renewed automatically as it
 * approaches expiry. `check()` must be called between sub-steps; it returns false the
 * moment the lease is lost, and the caller must stop writing.
 */
export class LeaseGuard {
  private expiresAt: Date;
  private lost = false;
  private readonly renew: (now: Date) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(
    renew: (now: Date) => Promise<boolean>,
    expiresAt: Date,
    now: () => Date = () => new Date(),
    ttlMs: number = LEASE_TTL_MS,
  ) {
    this.renew = renew;
    this.expiresAt = expiresAt;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** Renews if within `LEASE_RENEW_BEFORE_MS` of expiry. Returns whether we still hold it. */
  async check(): Promise<boolean> {
    if (this.lost) return false;
    const now = this.now();
    if (this.expiresAt.getTime() - now.getTime() > LEASE_RENEW_BEFORE_MS) return true;
    const ok = await this.renew(now);
    if (!ok) {
      this.lost = true;
      return false;
    }
    this.expiresAt = new Date(now.getTime() + this.ttlMs);
    return true;
  }
}
