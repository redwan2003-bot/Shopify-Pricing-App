/**
 * Task 6A.1 — dry-run evidence, backed by a STRONG target-state fingerprint.
 *
 * WHY THE 6A FINGERPRINT WAS NOT ENOUGH
 * The first implementation hashed aggregates: a row count, the newest `shopifyUpdatedAt`,
 * the newest row `updatedAt`, and the sum of profile revisions. Every one of those is
 * blind to a compensating change — swap one product for another, flip an override from
 * profile A to profile B, or delete one product while adding another in the same tick,
 * and the count, the newest timestamp and the revision sum can all land on exactly the
 * values the dry run captured. The apply would then proceed against a target set that is
 * not the one the merchant reviewed.
 *
 * WHAT THIS DOES INSTEAD
 * `computeTargetStateFingerprint` streams the ACTUAL per-product target state — in a
 * stable id order, in bounded batches — through an incremental SHA-256. For every product
 * in the selection it folds in:
 *
 *   - the Shopify product GID                       (which product)
 *   - `shopifyUpdatedAt` + `updatedAt`              (row identity / when it last moved)
 *   - `removedFromShopifyAt`                        (removed state)
 *   - the currently assigned profile id             (existing assignment)
 *   - the current override's active flag, profile and base price
 *   - `policyDigest` + `policySyncedAt`             (cached app-owned policy identity)
 *
 * plus, once, the target profile id, its revision AND its pricing-content digest, and the
 * replacement setting. Any single-product difference changes the digest, so an
 * equal-count / equal-newest-timestamp / equal-revision-sum swap is still caught.
 *
 * Memory stays bounded: rows are consumed `FINGERPRINT_BATCH` at a time and folded into
 * the hash, never accumulated. The browser only ever receives the resulting digest plus
 * aggregate counts — never the per-product state that produced it.
 */

import { createHash, type Hash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { iterateSelection, type SelectionDescriptor } from "./selection.ts";
import { loadOverridesByGid } from "./override-store.ts";

/** Rows folded into the running hash per pass. */
export const FINGERPRINT_BATCH = 500;

export interface FingerprintInputs {
  shopDomain: string;
  selectionHash: string;
  profileId: string;
  profileRevision: number;
  /** Task 6A.1 — the profile's pricing-content digest (see pricing/revision.ts). */
  profileDigest: string | null;
  replaceExisting: boolean;
  matchedCount: number;
  /** The streamed per-product target-state digest. */
  targetStateDigest: string;
}

/** Deterministic SHA-256 over the canonical, key-ordered dry-run inputs. */
export function computeDryRunFingerprint(inputs: FingerprintInputs): string {
  const canonical = [
    `shop=${inputs.shopDomain}`,
    `sel=${inputs.selectionHash}`,
    `profile=${inputs.profileId}`,
    `rev=${inputs.profileRevision}`,
    `pdigest=${inputs.profileDigest ?? "nodigest"}`,
    `replace=${inputs.replaceExisting ? 1 : 0}`,
    `matched=${inputs.matchedCount}`,
    `target=${inputs.targetStateDigest}`,
  ].join("\n");
  return "drf_" + createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface TargetStateResult {
  /** SHA-256 hex of the streamed per-product state. */
  digest: string;
  /** How many products were folded in. */
  productCount: number;
  /** How many bounded passes it took (performance evidence). */
  batches: number;
}

interface TargetRow {
  shopifyProductId: string;
  shopifyUpdatedAt: Date | null;
  updatedAt: Date;
  removedFromShopifyAt: Date | null;
  assignedProfileId: string | null;
  policyDigest: string | null;
  policySyncedAt: Date | null;
}

/**
 * Streams the selection's per-product target state through an incremental SHA-256.
 *
 * The stream is ordered by `CatalogProduct.id` (the same stable order `iterateSelection`
 * yields), so the digest is reproducible: the dry run and the apply compute it over the
 * same sequence and get the same value iff nothing in the target set moved.
 */
export async function computeTargetStateFingerprint(
  prisma: PrismaClient,
  storeId: string,
  selection: SelectionDescriptor,
  target: { profileId: string; profileRevision: number; profileDigest: string | null; replaceExisting: boolean },
): Promise<TargetStateResult> {
  const hash: Hash = createHash("sha256");
  // Fold the target parameters in FIRST, so two selections that resolve to the same
  // products but a different desired outcome never share a digest.
  hash.update(
    [
      "v2", // fingerprint algorithm version — bump to invalidate all outstanding evidence
      `store=${storeId}`,
      `target=${target.profileId}`,
      `rev=${target.profileRevision}`,
      `pdigest=${target.profileDigest ?? "nodigest"}`,
      `replace=${target.replaceExisting ? 1 : 0}`,
      "",
    ].join("\n"),
    "utf8",
  );

  let productCount = 0;
  let batches = 0;

  for await (const batch of iterateSelection(prisma, storeId, selection, FINGERPRINT_BATCH)) {
    batches += 1;
    const gids = batch.map((b) => b.shopifyProductId);

    const [products, overrideByGid] = await Promise.all([
      prisma.catalogProduct.findMany({
        where: { storeId, shopifyProductId: { in: gids } },
        select: {
          shopifyProductId: true,
          shopifyUpdatedAt: true,
          updatedAt: true,
          removedFromShopifyAt: true,
          assignedProfileId: true,
          policyDigest: true,
          policySyncedAt: true,
        },
      }),
      loadOverridesByGid(prisma, storeId, gids, { shopifyProductId: true, pricingProfileId: true, isActive: true, basePriceCents: true }),
    ]);

    const productByGid = new Map<string, TargetRow>(products.map((p) => [p.shopifyProductId, p]));

    // `iterateSelection` already yields a stable ascending `id` order; preserve it.
    for (const { shopifyProductId } of batch) {
      productCount += 1;
      const p = productByGid.get(shopifyProductId);
      const ov = overrideByGid.get(shopifyProductId);
      hash.update(serializeProductState(shopifyProductId, p, ov), "utf8");
    }
  }

  hash.update(`\ncount=${productCount}\n`, "utf8");
  return { digest: hash.digest("hex"), productCount, batches };
}

/** One product's complete target-relevant state, as a single canonical line. */
function serializeProductState(
  gid: string,
  p: TargetRow | undefined,
  ov: { pricingProfileId: string | null; isActive: boolean; basePriceCents: number | null } | undefined,
): string {
  if (!p) {
    // Present in the selection but no catalog row (raced deletion) — still folded in, so
    // its disappearance changes the digest.
    return `${gid}|missing\n`;
  }
  return [
    gid,
    `su=${p.shopifyUpdatedAt?.getTime() ?? 0}`,
    `ru=${p.updatedAt.getTime()}`,
    `rm=${p.removedFromShopifyAt?.getTime() ?? 0}`,
    `ap=${p.assignedProfileId ?? "-"}`,
    `pd=${p.policyDigest ?? "-"}`,
    `ps=${p.policySyncedAt?.getTime() ?? 0}`,
    `oa=${ov ? (ov.isActive ? 1 : 0) : "-"}`,
    `op=${ov?.pricingProfileId ?? "-"}`,
    `ob=${ov?.basePriceCents ?? "-"}`,
  ].join("|") + "\n";
}

/**
 * A cheap store-wide catalog digest, retained for the coverage UI and for the
 * `catalogFingerprint` column. It is NOT the apply gate — `computeTargetStateFingerprint`
 * is. Kept because it is O(few indexed queries) and useful for "has anything at all
 * changed since the last sync?" display.
 */
export async function computeCatalogFingerprint(
  prisma: Pick<PrismaClient, "catalogProduct" | "pricingProfile">,
  storeId: string,
): Promise<string> {
  const [count, newestShopify, newestRow, profileRevSum] = await Promise.all([
    prisma.catalogProduct.count({ where: { storeId, removedFromShopifyAt: null } }),
    prisma.catalogProduct.findFirst({
      where: { storeId, removedFromShopifyAt: null },
      orderBy: { shopifyUpdatedAt: "desc" },
      select: { shopifyUpdatedAt: true },
    }),
    prisma.catalogProduct.findFirst({
      where: { storeId },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    prisma.pricingProfile.aggregate({ where: { storeId }, _sum: { revision: true } }),
  ]);
  const canonical = [
    `n=${count}`,
    `sh=${newestShopify?.shopifyUpdatedAt?.getTime() ?? 0}`,
    `row=${newestRow?.updatedAt?.getTime() ?? 0}`,
    `prev=${profileRevSum._sum.revision ?? 0}`,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 24);
}
