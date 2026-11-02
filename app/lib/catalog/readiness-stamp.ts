import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { checkEnforcementDisabled } from "./enforcement-guard.ts";
import { auditOverrideKeys } from "./override-key-audit.ts";
import { loadOverridesByGid } from "./override-store.ts";
import { buildProductPolicyValue, canonicalPolicyJson, normalizeExistingPolicyJson } from "./policy-value.ts";
import { planBulkAssignment } from "./dry-run.ts";
import { confirmAndCreateJob } from "./apply.ts";
import { processAssignmentJob } from "./processor.ts";
import type { CatalogWritePort } from "./write-port.ts";
import { resolveEnforceableCurrency } from "../pricing-api/currency-contract.ts";

/**
 * Processor-confirmed readiness for products whose override and Shopify policy metafield
 * are ALREADY correct. The only thing that can stamp `policySyncedAt` / `policyDigest` /
 * `enforcementReady` is the assignment processor, after it has re-read Shopify and seen the
 * exact desired policy; this runner drives that processor, one single-product job per
 * profile, and nothing else.
 *
 *  plan      read-only: DB selects and Shopify QUERIES. Lists every product that would be
 *            stamped (live digest, profile, current columns) and every product that could
 *            not be (and why). Writes no Shopify data and creates no job rows.
 *  apply     refuses while `enforcement_policy.enabled` is true (checked before anything and
 *            again before every job), refuses unless the rebuilt plan hashes to the approved
 *            one and has no blocked rows. Writes a manifest BEFORE the first job, then runs
 *            plan -> confirm -> process per product, each guarded by a compare-and-set on the
 *            row's columns and on the live digest. The first conflict or surprise stops the run.
 *  rollback  restores the before-values, only for rows still holding exactly what this run
 *            wrote. Shopify is never touched: this runner never writes to it.
 *
 * The write port handed to the processor refuses every write, so even a plan that was wrong
 * could not change a Shopify metafield: the item would fail instead.
 */

export interface ReadinessColumns {
  assignedProfileId: string | null;
  assignmentSource: string | null;
  coverageStatus: string;
  enforcementReady: boolean;
  policySyncedAt: string | null;
  policyDigest: string | null;
}

export interface ReadinessRow {
  productGid: string;
  catalogProductId: string;
  profileId: string;
  profileRevision: number;
  /** Shopify's compare token for the live metafield at plan time */
  liveDigest: string;
  before: ReadinessColumns;
}

export interface ReadinessPlan {
  shop: string;
  storeId: string;
  enforcement: { enabled: boolean | null; applyBlocked: boolean; reason: string | null };
  rows: ReadinessRow[];
  blocked: Array<{ productGid: string; reason: string }>;
  totals: { overrides: number; stamp: number; alreadyReady: number; blocked: number; blockedByReason: Record<string, number> };
  hash: string;
}

export interface ReadinessContract {
  stamp: number;
  alreadyReady: number;
  blocked: number;
}

export type ReadinessStatus = "planned" | "done" | "failed" | "skipped";

export interface ReadinessManifest {
  version: 1;
  kind: "readiness-stamp";
  createdAt: string;
  shop: string;
  storeId: string;
  planHash: string;
  state: "planned" | "applying" | "completed" | "aborted" | "rolled_back";
  abortedBecause?: string[];
  shopifyWriteAttempts: number;
  entries: Array<ReadinessRow & { status: ReadinessStatus; jobId?: string; after?: ReadinessColumns; error?: string; rolledBack?: string }>;
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const GID_CHUNK = 500;

const toGid = (key: string) => (key.startsWith("gid://") ? key : `gid://shopify/Product/${key}`);

const COLUMN_SELECT = {
  id: true,
  shopifyProductId: true,
  assignedProfileId: true,
  assignmentSource: true,
  coverageStatus: true,
  enforcementReady: true,
  policySyncedAt: true,
  policyDigest: true,
  removedFromShopifyAt: true,
} as const;

type ProductRow = {
  id: string;
  shopifyProductId: string;
  assignedProfileId: string | null;
  assignmentSource: string | null;
  coverageStatus: string;
  enforcementReady: boolean;
  policySyncedAt: Date | null;
  policyDigest: string | null;
  removedFromShopifyAt: Date | null;
};

const columnsOf = (p: ProductRow): ReadinessColumns => ({
  assignedProfileId: p.assignedProfileId,
  assignmentSource: p.assignmentSource,
  coverageStatus: p.coverageStatus,
  enforcementReady: p.enforcementReady,
  policySyncedAt: iso(p.policySyncedAt),
  policyDigest: p.policyDigest,
});

/** The port the processor is given: reads pass through, any write is refused and counted. */
export function readOnlyPort(port: CatalogWritePort, counter: { attempts: number }): CatalogWritePort {
  const refuse = (): never => {
    counter.attempts += 1;
    throw new Error("the readiness runner is read-only toward Shopify; refusing a metafield write");
  };
  return {
    readProductPolicies: (gids) => port.readProductPolicies(gids),
    setProductPolicies: async () => refuse(),
    deleteProductPolicy: async () => refuse(),
  };
}

export async function buildReadinessPlan(deps: {
  prisma: PrismaClient;
  port: CatalogWritePort;
  storeId: string;
  shop: string;
  shopPolicyJson: unknown;
}): Promise<ReadinessPlan> {
  const { prisma, port, storeId, shop } = deps;
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { shopDomain: true, shopCurrency: true } });
  if (!store || store.shopDomain !== shop) throw new Error("the store id does not belong to the confirmed shop");

  const gate = checkEnforcementDisabled(deps.shopPolicyJson);
  const enabled = deps.shopPolicyJson && typeof deps.shopPolicyJson === "object" ? Boolean((deps.shopPolicyJson as { enabled?: unknown }).enabled) : null;
  const enforcement = { enabled, applyBlocked: !gate.ok, reason: gate.ok ? null : gate.message };

  const overrides = await prisma.productPricingOverride.findMany({ where: { storeId, isActive: true }, select: { shopifyProductId: true } });
  const gids = [...new Set(overrides.map((o) => toGid(o.shopifyProductId)))].sort();

  const profiles = new Map(
    (await prisma.pricingProfile.findMany({ where: { storeId }, select: { id: true, revision: true, isActive: true, currency: true } })).map((p) => [p.id, p]),
  );

  const blocked: ReadinessPlan["blocked"] = [];
  const rows: ReadinessRow[] = [];
  let alreadyReady = 0;

  for (let i = 0; i < gids.length; i += GID_CHUNK) {
    const chunk = gids.slice(i, i + GID_CHUNK);
    const [products, effective, audit, reads] = await Promise.all([
      prisma.catalogProduct.findMany({ where: { storeId, shopifyProductId: { in: chunk } }, select: COLUMN_SELECT }),
      loadOverridesByGid(prisma, storeId, chunk, { shopifyProductId: true, pricingProfileId: true, isActive: true }),
      auditOverrideKeys(prisma, storeId, chunk),
      port.readProductPolicies(chunk),
    ]);
    const byGid = new Map((products as ProductRow[]).map((p) => [p.shopifyProductId, p]));

    for (const gid of chunk) {
      const block = (reason: string) => blocked.push({ productGid: gid, reason });
      const p = byGid.get(gid);
      if (!p || p.removedFromShopifyAt) { block("product_missing"); continue; }
      if (audit.blockedGids.has(gid)) { block("override_key_conflict"); continue; }
      const ov = effective.get(gid);
      if (!ov || !ov.isActive || !ov.pricingProfileId) { block("no_active_override"); continue; }
      const profile = profiles.get(ov.pricingProfileId);
      if (!profile) { block("profile_missing"); continue; }
      if (!profile.isActive) { block("profile_inactive"); continue; }
      if (!resolveEnforceableCurrency(profile.currency, store.shopCurrency).ok) { block("currency_mismatch"); continue; }
      if (p.policySyncedAt != null) { alreadyReady += 1; continue; }

      const read = reads.get(gid);
      if (!read || !read.present) { block("policy_absent"); continue; }
      const want = canonicalPolicyJson(buildProductPolicyValue({ profileId: profile.id, profileRevision: profile.revision, policyRevision: 1 }));
      if (normalizeExistingPolicyJson(read.jsonValue) !== want) { block("policy_differs"); continue; }
      if (!read.compareDigest) { block("policy_digest_missing"); continue; }
      rows.push({ productGid: gid, catalogProductId: p.id, profileId: profile.id, profileRevision: profile.revision, liveDigest: read.compareDigest, before: columnsOf(p) });
    }
  }

  const blockedByReason: Record<string, number> = {};
  for (const b of blocked) blockedByReason[b.reason] = (blockedByReason[b.reason] ?? 0) + 1;
  const hash = createHash("sha256")
    .update(stable({ shop, storeId, rows: rows.map((r) => ({ g: r.productGid, p: r.profileId, r: r.profileRevision, d: r.liveDigest, b: r.before })), blocked }))
    .digest("hex");

  return {
    shop,
    storeId,
    enforcement,
    rows,
    blocked,
    totals: { overrides: gids.length, stamp: rows.length, alreadyReady, blocked: blocked.length, blockedByReason },
    hash,
  };
}

export function checkReadinessContract(plan: ReadinessPlan, contract: ReadinessContract): string[] {
  const problems: string[] = [];
  if (plan.totals.stamp !== contract.stamp) problems.push(`stamp: expected ${contract.stamp}, got ${plan.totals.stamp}`);
  if (plan.totals.alreadyReady !== contract.alreadyReady) problems.push(`alreadyReady: expected ${contract.alreadyReady}, got ${plan.totals.alreadyReady}`);
  if (plan.totals.blocked !== contract.blocked) problems.push(`blocked: expected ${contract.blocked}, got ${plan.totals.blocked} (${JSON.stringify(plan.totals.blockedByReason)})`);
  return problems;
}

type ApplyResult = {
  state: ReadinessManifest["state"] | "refused";
  refusedBecause?: string[];
  abortedBecause?: string[];
  stamped: number;
  manifest?: ReadinessManifest;
};

export async function applyReadinessPlan(deps: {
  prisma: PrismaClient;
  port: CatalogWritePort;
  storeId: string;
  shop: string;
  approvedHash: string;
  /** Fresh read of the shop `enforcement_policy` metafield jsonValue; called before the run and before every job. */
  readShopPolicyJson: () => Promise<unknown>;
  onManifest: (m: ReadinessManifest) => Promise<void>;
  now?: () => Date;
}): Promise<ApplyResult> {
  const { prisma, storeId, shop } = deps;

  // 1. The enforcement gate comes first: nothing is built, recorded or written while it is closed.
  const shopPolicy0 = await deps.readShopPolicyJson();
  const gate0 = checkEnforcementDisabled(shopPolicy0);
  if (!gate0.ok) return { state: "refused", refusedBecause: [gate0.message], stamped: 0 };

  const counter = { attempts: 0 };
  const port = readOnlyPort(deps.port, counter);
  const plan = await buildReadinessPlan({ prisma, port, storeId, shop, shopPolicyJson: shopPolicy0 });
  if (plan.hash !== deps.approvedHash) return { state: "refused", refusedBecause: ["the live plan no longer matches the approved plan (hash differs); re-run plan mode and review again"], stamped: 0 };
  if (plan.totals.blocked > 0) return { state: "refused", refusedBecause: [`the plan has ${plan.totals.blocked} blocked row(s): ${JSON.stringify(plan.totals.blockedByReason)}`], stamped: 0 };

  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { shopCurrency: true } });
  const manifest: ReadinessManifest = {
    version: 1,
    kind: "readiness-stamp",
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    shop,
    storeId,
    planHash: plan.hash,
    state: "planned",
    shopifyWriteAttempts: 0,
    entries: plan.rows.map((r) => ({ ...r, status: "planned" as ReadinessStatus })),
  };
  await deps.onManifest(manifest); // BEFORE the first job: the audit and rollback record
  manifest.state = "applying";

  const abort = async (entryIdx: number | null, why: string): Promise<ApplyResult> => {
    manifest.state = "aborted";
    manifest.abortedBecause = [why];
    manifest.shopifyWriteAttempts = counter.attempts;
    for (const [i, e] of manifest.entries.entries()) if (e.status === "planned" && i !== entryIdx) e.status = "skipped";
    await deps.onManifest(manifest);
    return { state: "aborted", abortedBecause: [why], stamped: manifest.entries.filter((e) => e.status === "done").length, manifest };
  };

  for (const [idx, entry] of manifest.entries.entries()) {
    // fresh gate before EVERY job: enforcement may have been switched on mid-run
    const shopPolicy = await deps.readShopPolicyJson();
    const gate = checkEnforcementDisabled(shopPolicy);
    if (!gate.ok) { entry.status = "skipped"; return abort(null, `stopped before ${entry.productGid}: ${gate.message}`); }

    // compare-and-set on the local row and on the live metafield digest
    const row = (await prisma.catalogProduct.findFirst({ where: { id: entry.catalogProductId, storeId }, select: COLUMN_SELECT })) as ProductRow | null;
    if (!row || stable(columnsOf(row)) !== stable(entry.before)) { entry.status = "failed"; entry.error = "row changed since the plan"; return abort(idx, `${entry.productGid}: the catalog row changed since the plan; not touched`); }
    const live = (await port.readProductPolicies([entry.productGid])).get(entry.productGid);
    if (!live?.present || live.compareDigest !== entry.liveDigest) { entry.status = "failed"; entry.error = "metafield digest changed since the plan"; return abort(idx, `${entry.productGid}: the live policy metafield changed since the plan; not touched`); }

    try {
      const dry = await planBulkAssignment(prisma, {
        storeId, shopDomain: shop, shopCurrency: store.shopCurrency,
        selection: { kind: "ids", ids: [entry.productGid] },
        pricingProfileId: entry.profileId, replaceExisting: false,
        idempotencyKey: `readiness-${plan.hash.slice(0, 16)}-${entry.productGid.split("/").pop()}`,
      });
      if (!dry.ok) throw new Error(`dry run refused: ${dry.code}`);
      if (dry.counts.verificationRequired !== 1 || dry.counts.totalMatched !== 1 || dry.counts.estimatedOperations !== 0) {
        throw new Error(`dry run is not a pure verification: ${JSON.stringify(dry.counts)}`);
      }
      const applied = await confirmAndCreateJob(prisma, {
        storeId, shopDomain: shop, shopCurrency: store.shopCurrency, jobId: dry.jobId,
        echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: shopPolicy,
      });
      if (!applied.ok) throw new Error(`apply refused: ${applied.code}`);
      entry.jobId = dry.jobId;
      const result = await processAssignmentJob(prisma, storeId, dry.jobId, { port, shopEnforcementPolicyJson: shopPolicy, maxBatches: 2, now: deps.now });
      if (result.refused) throw new Error(`processor refused: ${result.refused.reason}`);
      if (result.unchanged !== 1 || result.succeeded !== 0 || result.failed !== 0 || result.conflicts !== 0) {
        throw new Error(`processor outcome was not a single 'unchanged': ${JSON.stringify({ u: result.unchanged, s: result.succeeded, f: result.failed, c: result.conflicts, status: result.status })}`);
      }
      const after = columnsOf((await prisma.catalogProduct.findFirstOrThrow({ where: { id: entry.catalogProductId, storeId }, select: COLUMN_SELECT })) as ProductRow);
      if (!after.policySyncedAt || after.policyDigest !== entry.liveDigest || !after.enforcementReady || after.assignedProfileId !== entry.profileId) {
        entry.after = after;
        throw new Error("the stamped columns are not what the plan expected");
      }
      entry.after = after;
      entry.status = "done";
    } catch (error) {
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<url>").slice(0, 300) : "failed";
      return abort(idx, `${entry.productGid}: ${entry.error}`);
    }
    manifest.shopifyWriteAttempts = counter.attempts;
    await deps.onManifest(manifest);
    if (counter.attempts > 0) return abort(null, "a Shopify write was attempted; stopping");
  }

  manifest.state = "completed";
  manifest.shopifyWriteAttempts = counter.attempts;
  await deps.onManifest(manifest);
  return { state: "completed", stamped: manifest.entries.length, manifest };
}

export async function rollbackReadiness(deps: {
  prisma: PrismaClient;
  storeId: string;
  shop: string;
  manifest: ReadinessManifest;
  onManifest: (m: ReadinessManifest) => Promise<void>;
}): Promise<{ restored: number; skipped: string[] }> {
  const { manifest, prisma, storeId } = deps;
  if (manifest.shop !== deps.shop || manifest.storeId !== storeId) throw new Error("the manifest belongs to a different shop or store");
  const toData = (c: ReadinessColumns) => ({ ...c, policySyncedAt: c.policySyncedAt ? new Date(c.policySyncedAt) : null });
  let restored = 0;
  const skipped: string[] = [];
  for (const e of manifest.entries) {
    if (e.status !== "done" || !e.after) continue;
    const res = await prisma.catalogProduct.updateMany({ where: { id: e.catalogProductId, storeId, ...toData(e.after) }, data: toData(e.before) });
    if (res.count === 1) { e.rolledBack = "restored"; restored += 1; }
    else { e.rolledBack = "skipped: the row changed after this run wrote it"; skipped.push(`${e.productGid}: the row changed after this run; left alone`); }
  }
  manifest.state = "rolled_back";
  await deps.onManifest(manifest);
  return { restored, skipped };
}
