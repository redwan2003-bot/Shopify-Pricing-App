/**
 * Task 6A / 6A.1 — dry-run planning for a bulk pricing-profile assignment.
 *
 * ALWAYS the first step. Produces deterministic counts (a pure function of the selection,
 * the target profile and the current catalog state), persists them on a
 * `BulkAssignmentJob` row in status `dry_run`, and returns a fingerprint the merchant's
 * browser must echo back on `--apply`. Nothing is written to Shopify or to
 * `ProductPricingOverride` here.
 *
 * 6A.1 strengthens the evidence in two ways:
 *   - the fingerprint covers a STREAMED per-product target-state digest, not aggregates,
 *     so a change that preserves the row count / newest timestamp / revision sum is still
 *     detected (see `fingerprint.ts`);
 *   - the target profile is captured as `revision` AND `contentDigest`, so an edit to any
 *     pricing-affecting child table invalidates the dry run even if `revision` were
 *     somehow left alone (see `pricing/revision.ts`).
 */

import type { PrismaClient } from "@prisma/client";
import { DRY_RUN_TTL_MS } from "./constants.ts";
import { computeCatalogFingerprint, computeDryRunFingerprint, computeTargetStateFingerprint } from "./fingerprint.ts";
import { hashSelection, iterateSelection, type SelectionDescriptor } from "./selection.ts";
import { loadOverridesByGid } from "./override-store.ts";
import { auditOverrideKeys, describeOverrideKeyConflict } from "./override-key-audit.ts";
import { resolveEnforceableCurrency } from "../pricing-api/currency-contract.ts";
import { ensurePricingContentDigest } from "../pricing/revision.ts";

export interface DryRunRequest {
  storeId: string;
  shopDomain: string;
  shopCurrency: string | null;
  selection: SelectionDescriptor;
  pricingProfileId: string;
  replaceExisting: boolean;
  /** Opaque Shopify staff-user id. No staff email is stored (see the schema note). */
  createdByUserId?: string | null;
  idempotencyKey: string;
}

export interface DryRunCounts {
  totalMatched: number;
  eligible: number; // unassigned → will be assigned
  unchanged: number; // already at the desired profile AND the app-owned policy is locally synced
  /**
   * Task 6A.3B §1 — a local active override ALREADY names the target profile, but the
   * app-owned `pricing_policy` metafield has never been confirmed locally
   * (`policySyncedAt` is null). The processor will RE-READ Shopify and, if the metafield
   * is already exactly right (the common case — e.g. it was written by the provisioner's
   * pilot preparation), record `unchanged` and perform ZERO writes; only if Shopify
   * actually disagrees does it write. So this is NOT counted as a planned write.
   */
  verificationRequired: number;
  alreadyAssigned: number; // assigned to another profile
  replacementRequired: number; // alreadyAssigned AND replaceExisting
  invalid: number; // product no longer in Shopify / malformed
  skipped: number; // alreadyAssigned AND NOT replaceExisting
  estimatedOperations: number; // GUARANTEED Shopify writes: (eligible + replacementRequired) — NOT verificationRequired
}

export interface DryRunProfile {
  id: string;
  name: string;
  revision: number;
  contentDigest: string | null;
  currency: string;
  isActive: boolean;
}

export type DryRunResult =
  | {
      ok: true;
      jobId: string;
      dryRunFingerprint: string;
      expiresAt: Date;
      profile: DryRunProfile;
      counts: DryRunCounts;
      blockingErrors: string[];
      /** performance evidence — how many bounded passes the fingerprint took */
      fingerprintBatches: number;
    }
  | { ok: false; code: string; message: string; blockingErrors: string[] };

export async function planBulkAssignment(prisma: PrismaClient, req: DryRunRequest): Promise<DryRunResult> {
  const blockingErrors: string[] = [];

  // Idempotent: a repeat with the same key returns the existing, unexpired dry run.
  const existing = await prisma.bulkAssignmentJob.findUnique({
    where: { storeId_idempotencyKey: { storeId: req.storeId, idempotencyKey: req.idempotencyKey } },
  });
  if (existing && existing.status === "dry_run" && existing.dryRunExpiresAt && existing.dryRunExpiresAt > new Date()) {
    const prof = await prisma.pricingProfile.findFirst({ where: { id: existing.pricingProfileId ?? "", storeId: req.storeId } });
    if (prof) {
      return {
        ok: true,
        jobId: existing.id,
        dryRunFingerprint: existing.dryRunFingerprint!,
        expiresAt: existing.dryRunExpiresAt,
        profile: { id: prof.id, name: prof.name, revision: prof.revision, contentDigest: prof.contentDigest, currency: prof.currency, isActive: prof.isActive },
        counts: JSON.parse(existing.selectionDescriptor).__counts ?? emptyCounts(),
        blockingErrors: [],
        fingerprintBatches: 0,
      };
    }
  }

  // 1. Profile — store-scoped, active, currency-compatible with the shop.
  const profile = await prisma.pricingProfile.findFirst({
    where: { id: req.pricingProfileId, storeId: req.storeId },
    select: { id: true, name: true, revision: true, contentDigest: true, currency: true, isActive: true },
  });
  if (!profile) {
    return { ok: false, code: "PROFILE_NOT_FOUND", message: "pricing profile not found for this shop", blockingErrors: ["pricing profile not found for this shop"] };
  }
  // A profile that predates the digest mechanism gets one backfilled WITHOUT bumping its
  // revision — the first observation of existing content is not a change.
  const contentDigest = profile.contentDigest ?? (await ensurePricingContentDigest(prisma, profile.id));

  if (!profile.isActive) blockingErrors.push(`pricing profile "${profile.name}" is inactive — activate it before assigning`);
  const currencyGate = resolveEnforceableCurrency(profile.currency, req.shopCurrency);
  if (!currencyGate.ok) {
    blockingErrors.push(
      `currency mismatch — profile "${profile.name}" is priced in ${profile.currency}, shop currency is ${req.shopCurrency ?? "unknown"} (${currencyGate.reason}). Assignment would never be enforcement-ready.`,
    );
  }

  // 2. Classify every selected product (deterministic, store-scoped, bounded batches).
  const counts = emptyCounts();
  const desiredProfileId = profile.id;
  const overrideKeyConflicts: string[] = [];

  for await (const batch of iterateSelection(prisma, req.storeId, req.selection)) {
    counts.totalMatched += batch.length;
    const gids = batch.map((b) => b.shopifyProductId);

    // Task 6A.3B §4 — a legacy GID-keyed override that DISAGREES with the bare-keyed one
    // makes the product's effective price ambiguous. Surface it as a blocking error so it
    // is fixed before any assignment; the processor also fails these items closed.
    const keyAudit = await auditOverrideKeys(prisma, req.storeId, gids);
    for (const c of keyAudit.conflicts) overrideKeyConflicts.push(describeOverrideKeyConflict(c));

    const [products, ovByGid] = await Promise.all([
      prisma.catalogProduct.findMany({
        where: { storeId: req.storeId, shopifyProductId: { in: gids } },
        select: { shopifyProductId: true, policySyncedAt: true, removedFromShopifyAt: true },
      }),
      loadOverridesByGid(prisma, req.storeId, gids, { shopifyProductId: true, pricingProfileId: true, isActive: true }),
    ]);
    const prodByGid = new Map(products.map((p) => [p.shopifyProductId, p]));

    for (const { shopifyProductId } of batch) {
      const p = prodByGid.get(shopifyProductId);
      if (!p || p.removedFromShopifyAt) {
        counts.invalid += 1;
        continue;
      }
      const ov = ovByGid.get(shopifyProductId);
      const currentProfileId = ov && ov.isActive ? (ov.pricingProfileId ?? null) : null;

      if (currentProfileId === desiredProfileId) {
        // The override already names the target profile. Whether this needs a Shopify
        // write depends ONLY on the app-owned policy metafield, which the dry run does not
        // read: `policySyncedAt` set → locally confirmed, nothing to do; not set → the
        // processor must verify against Shopify (usually a no-op — see the count doc).
        if (p.policySyncedAt != null) counts.unchanged += 1;
        else counts.verificationRequired += 1;
      } else if (currentProfileId != null && currentProfileId !== desiredProfileId) {
        counts.alreadyAssigned += 1;
        if (req.replaceExisting) counts.replacementRequired += 1;
        else counts.skipped += 1;
      } else {
        counts.eligible += 1;
      }
    }
  }
  // GUARANTEED writes only. `verificationRequired` items perform 0 writes when Shopify
  // already agrees (the common case) and 1 only when it does not, so they are never
  // presented as planned writes — the processor reports each as unchanged or succeeded.
  counts.estimatedOperations = counts.eligible + counts.replacementRequired;

  if (overrideKeyConflicts.length > 0) {
    blockingErrors.push(
      `${overrideKeyConflicts.length} product(s) have a conflicting legacy pricing-override record — ` +
        `resolve these before assigning: ${overrideKeyConflicts.slice(0, 5).join("; ")}` +
        (overrideKeyConflicts.length > 5 ? `; …and ${overrideKeyConflicts.length - 5} more` : ""),
    );
  }

  // 3. Fingerprint the plan — streamed per-product target state, not aggregates.
  const targetState = await computeTargetStateFingerprint(prisma, req.storeId, req.selection, {
    profileId: profile.id,
    profileRevision: profile.revision,
    profileDigest: contentDigest,
    replaceExisting: req.replaceExisting,
  });
  const catalogFingerprint = await computeCatalogFingerprint(prisma, req.storeId);
  const dryRunFingerprint = computeDryRunFingerprint({
    shopDomain: req.shopDomain,
    selectionHash: hashSelection(req.selection),
    profileId: profile.id,
    profileRevision: profile.revision,
    profileDigest: contentDigest,
    replaceExisting: req.replaceExisting,
    matchedCount: counts.totalMatched,
    targetStateDigest: targetState.digest,
  });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DRY_RUN_TTL_MS);

  const shared = {
    pricingProfileId: profile.id,
    profileRevision: profile.revision,
    profileDigest: contentDigest,
    profileCurrency: profile.currency,
    replaceExisting: req.replaceExisting,
    selectionKind: req.selection.kind,
    selectionDescriptor: JSON.stringify({ ...req.selection, __counts: counts }),
    catalogFingerprint,
    dryRunFingerprint,
    dryRunIssuedAt: now,
    dryRunExpiresAt: expiresAt,
    // Every item the apply will MATERIALIZE — writes plus verification-required items,
    // which are materialized so the processor can re-read Shopify and settle them.
    totalItems: counts.eligible + counts.replacementRequired + counts.verificationRequired,
    createdByUserId: req.createdByUserId ?? null,
  };

  const job = await prisma.bulkAssignmentJob.upsert({
    where: { storeId_idempotencyKey: { storeId: req.storeId, idempotencyKey: req.idempotencyKey } },
    create: { storeId: req.storeId, jobType: "assign", status: "dry_run", idempotencyKey: req.idempotencyKey, ...shared },
    update: { status: "dry_run", ...shared },
  });

  await prisma.bulkAssignmentAudit.create({
    data: {
      storeId: req.storeId,
      jobId: job.id,
      event: "dry_run",
      detail: JSON.stringify({ counts, fingerprint: dryRunFingerprint, targetStateBatches: targetState.batches }),
    },
  });

  return {
    ok: true,
    jobId: job.id,
    dryRunFingerprint,
    expiresAt,
    profile: { id: profile.id, name: profile.name, revision: profile.revision, contentDigest, currency: profile.currency, isActive: profile.isActive },
    counts,
    blockingErrors,
    fingerprintBatches: targetState.batches,
  };
}

function emptyCounts(): DryRunCounts {
  return {
    totalMatched: 0,
    eligible: 0,
    unchanged: 0,
    verificationRequired: 0,
    alreadyAssigned: 0,
    replacementRequired: 0,
    invalid: 0,
    skipped: 0,
    estimatedOperations: 0,
  };
}
