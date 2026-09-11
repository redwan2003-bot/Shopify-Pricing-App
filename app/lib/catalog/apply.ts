/**
 * Task 6A / 6A.1 — turn a dry run into a queued, materialized bulk-assignment job.
 *
 * `--apply` re-verifies everything the dry run captured against CURRENT state and rejects
 * on ANY drift (see `ApplyRejection`). Only then does it create the per-product
 * `BulkAssignmentItem` rows (capturing the previous LOCAL override state — half the
 * rollback snapshot; the Shopify half is captured by the processor immediately before it
 * writes, together with the compare-and-set digest) and flip the job to `queued`.
 *
 * 6A.1: the fingerprint recomputation streams the per-product target state, and the
 * profile check compares `revision` AND `contentDigest`, so a pricing-affecting
 * child-table edit invalidates the evidence.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ASSIGN_BATCH_SIZE } from "./constants.ts";
import { checkEnforcementDisabled } from "./enforcement-guard.ts";
import { computeCatalogFingerprint, computeDryRunFingerprint, computeTargetStateFingerprint } from "./fingerprint.ts";
import { buildProductPolicyValue, canonicalPolicyJson } from "./policy-value.ts";
import { hashSelection, iterateSelection, parseSelectionDescriptor, type SelectionDescriptor } from "./selection.ts";
import { loadOverridesByGid } from "./override-store.ts";
import { resolveEnforceableCurrency } from "../pricing-api/currency-contract.ts";
import { revisionIdentityUnchanged } from "../pricing/revision.ts";

export type ApplyRejection =
  | "DRY_RUN_NOT_FOUND"
  | "DRY_RUN_WRONG_STATE"
  | "DRY_RUN_EXPIRED"
  | "FINGERPRINT_ECHO_MISMATCH"
  | "PROFILE_REVISION_CHANGED"
  | "CATALOG_CHANGED"
  | "TARGET_CHANGED"
  | "PROFILE_INACTIVE"
  | "CURRENCY_MISMATCH"
  | "ENFORCEMENT_ENABLED"
  | "PROFILE_NOT_FOUND";

export interface ConfirmApplyRequest {
  storeId: string;
  shopDomain: string;
  shopCurrency: string | null;
  jobId: string;
  /** the exact `dryRunFingerprint` the browser was shown — a tampered count or list on
   * the client produces a different value on the server's recompute */
  echoedFingerprint: string;
  /** the shop `$app:imprintid/enforcement_policy` metafield jsonValue, fetched once by
   * the route via the authenticated Admin client */
  shopEnforcementPolicyJson: unknown;
  /** the shop-policy `policyRevision` to stamp into each product policy (defaults 1) */
  shopPolicyRevision?: number;
}

export type ConfirmApplyResult =
  | { ok: true; jobId: string; totalItems: number; batchSize: number }
  | { ok: false; code: ApplyRejection; message: string };

export async function confirmAndCreateJob(prisma: PrismaClient, req: ConfirmApplyRequest): Promise<ConfirmApplyResult> {
  const job = await prisma.bulkAssignmentJob.findFirst({ where: { id: req.jobId, storeId: req.storeId } });
  if (!job) return reject("DRY_RUN_NOT_FOUND", "no dry-run for this shop with that id");
  // `materializing` = a previous apply crashed mid-way; re-entry with the SAME echoed
  // fingerprint resumes it (item creation is idempotent — see `alreadyMaterialized`).
  if (job.status !== "dry_run" && job.status !== "materializing") {
    return reject("DRY_RUN_WRONG_STATE", `job is "${job.status}", not "dry_run"`);
  }
  if (job.status === "dry_run" && (!job.dryRunExpiresAt || job.dryRunExpiresAt <= new Date())) {
    return reject("DRY_RUN_EXPIRED", "the dry run has expired — run it again");
  }
  if (req.echoedFingerprint !== job.dryRunFingerprint) {
    return reject("FINGERPRINT_ECHO_MISMATCH", "the confirmation does not match the dry run shown");
  }

  const profile = await prisma.pricingProfile.findFirst({
    where: { id: job.pricingProfileId ?? "", storeId: req.storeId },
    select: { id: true, name: true, revision: true, contentDigest: true, currency: true, isActive: true },
  });
  if (!profile) return reject("PROFILE_NOT_FOUND", "the pricing profile no longer exists");

  // Task 6A.1 — revision AND pricing-content digest. A change to any pricing-affecting
  // child table (tiers, decoration rules/charges, option groups/values, colours,
  // production, packaging) flips the digest and invalidates the dry run.
  // Task 6A.3B §5 — a capture made while the digest was still null, now non-null at the
  // same revision, is the first-observation backfill landing, not drift.
  if (!revisionIdentityUnchanged(job.profileRevision, job.profileDigest, profile.revision, profile.contentDigest)) {
    return reject("PROFILE_REVISION_CHANGED", "the pricing profile's priced content changed since the dry run — re-run it");
  }
  if (!profile.isActive) return reject("PROFILE_INACTIVE", `pricing profile "${profile.name}" is inactive`);

  const currencyGate = resolveEnforceableCurrency(profile.currency, req.shopCurrency);
  if (!currencyGate.ok) {
    return reject("CURRENCY_MISMATCH", `profile currency ${profile.currency} ≠ shop currency ${req.shopCurrency ?? "unknown"} (${currencyGate.reason})`);
  }

  const enforcement = checkEnforcementDisabled(req.shopEnforcementPolicyJson);
  if (!enforcement.ok) return reject("ENFORCEMENT_ENABLED", enforcement.message);

  const selection: SelectionDescriptor = parseSelectionDescriptor(JSON.parse(job.selectionDescriptor));

  // Recompute the fingerprint from CURRENT catalog state, streaming the per-product target
  // state. The PROFILE parameters folded in are the ones the dry run captured (`job.*`),
  // not the live values: profile drift is already caught, with a clearer error, by the
  // `revisionIdentityUnchanged` check above — so this fingerprint's job is purely to catch
  // a change to the selected PRODUCT SET, and a first-observation digest backfill (null →
  // value, same revision) must not read as such a change (Task 6A.3B §5).
  const fpProfileRevision = job.profileRevision ?? profile.revision;
  const fpProfileDigest = job.profileDigest;
  const targetState = await computeTargetStateFingerprint(prisma, req.storeId, selection, {
    profileId: profile.id,
    profileRevision: fpProfileRevision,
    profileDigest: fpProfileDigest,
    replaceExisting: job.replaceExisting,
  });
  const catalogFingerprint = await computeCatalogFingerprint(prisma, req.storeId);
  const recomputed = computeDryRunFingerprint({
    shopDomain: req.shopDomain,
    selectionHash: hashSelection(selection),
    profileId: profile.id,
    profileRevision: fpProfileRevision,
    profileDigest: fpProfileDigest,
    replaceExisting: job.replaceExisting,
    matchedCount: targetState.productCount,
    targetStateDigest: targetState.digest,
  });
  if (recomputed !== job.dryRunFingerprint) {
    if (catalogFingerprint !== job.catalogFingerprint) {
      return reject("CATALOG_CHANGED", "the catalog changed since the dry run — re-run it");
    }
    return reject("TARGET_CHANGED", "the state of the selected products changed since the dry run — re-run it");
  }

  // Materialize items — one per product that needs the processor to act: eligible +
  // replacement (a write is planned) plus verification-required (override already names
  // the target profile but the app-owned policy is not locally confirmed — the processor
  // re-reads Shopify and usually settles it as unchanged, no write). Captures the previous
  // LOCAL override state.
  const desiredPolicy = buildProductPolicyValue({
    profileId: profile.id,
    profileRevision: profile.revision,
    policyRevision: req.shopPolicyRevision ?? 1,
  });
  const newPolicyJson = canonicalPolicyJson(desiredPolicy);

  await prisma.bulkAssignmentJob.update({
    where: { id: job.id },
    data: { status: "materializing", startedAt: job.startedAt ?? new Date(), catalogFingerprint },
  });

  // Resumability: a crash mid-materialization leaves some items already created.
  const alreadyMaterialized = new Set(
    (await prisma.bulkAssignmentItem.findMany({ where: { jobId: job.id }, select: { shopifyProductId: true } })).map(
      (i) => i.shopifyProductId,
    ),
  );

  let created = 0;
  for await (const batch of iterateSelection(prisma, req.storeId, selection)) {
    const gids = batch.map((b) => b.shopifyProductId);
    const [products, ovByGid] = await Promise.all([
      prisma.catalogProduct.findMany({
        where: { storeId: req.storeId, shopifyProductId: { in: gids } },
        select: { id: true, shopifyProductId: true, policySyncedAt: true, removedFromShopifyAt: true },
      }),
      loadOverridesByGid(prisma, req.storeId, gids, { shopifyProductId: true, pricingProfileId: true, basePriceCents: true, isActive: true }),
    ]);
    const prodByGid = new Map(products.map((p) => [p.shopifyProductId, p]));

    const toCreate: Prisma.BulkAssignmentItemCreateManyInput[] = [];
    for (const { shopifyProductId } of batch) {
      if (alreadyMaterialized.has(shopifyProductId)) continue;
      const p = prodByGid.get(shopifyProductId);
      if (!p || p.removedFromShopifyAt) continue; // invalid — not a write target
      const ov = ovByGid.get(shopifyProductId);
      const currentProfileId = ov && ov.isActive ? (ov.pricingProfileId ?? null) : null;

      // unchanged → not an item
      if (currentProfileId === profile.id && p.policySyncedAt != null) continue;
      // already assigned elsewhere + replacement disabled → skipped, not an item
      if (currentProfileId != null && currentProfileId !== profile.id && !job.replaceExisting) continue;

      toCreate.push({
        storeId: req.storeId,
        jobId: job.id,
        shopifyProductId,
        catalogProductId: p.id,
        status: "pending",
        prevOverrideExisted: !!ov,
        prevOverrideProfileId: ov?.pricingProfileId ?? null,
        prevOverrideBaseCents: ov?.basePriceCents ?? null,
        prevOverrideActive: ov?.isActive ?? null,
        newProfileId: profile.id,
        newPolicyJson,
        idempotencyKey: randomUUID(),
      });
    }

    if (toCreate.length) {
      await prisma.bulkAssignmentItem.createMany({ data: toCreate });
      for (const c of toCreate) alreadyMaterialized.add(c.shopifyProductId);
      created += toCreate.length;
    }
  }

  const totalItems = await prisma.bulkAssignmentItem.count({ where: { jobId: job.id } });
  const job2 = await prisma.bulkAssignmentJob.update({
    where: { id: job.id },
    data: { status: "queued", totalItems, dryRunExpiresAt: new Date(Date.now() - 1) },
  });
  await prisma.bulkAssignmentAudit.create({
    data: { storeId: req.storeId, jobId: job.id, event: "apply_started", detail: JSON.stringify({ totalItems, newlyMaterialized: created }) },
  });

  return { ok: true, jobId: job2.id, totalItems, batchSize: ASSIGN_BATCH_SIZE };
}

function reject(code: ApplyRejection, message: string): ConfirmApplyResult {
  return { ok: false, code, message };
}
