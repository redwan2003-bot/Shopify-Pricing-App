import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { checkEnforcementDisabled } from "./enforcement-guard.ts";
import { buildProductPolicyValue, canonicalPolicyJson, normalizeExistingPolicyJson } from "./policy-value.ts";
import { METAFIELDS_SET_MAX } from "./admin-client.ts";
import type { CatalogWritePort } from "./write-port.ts";

/**
 * Narrows a pilot to a chosen set of products by editing the OTHER products' app-owned
 * `pricing_policy` metafield, compare-and-set, with a manifest and a rollback.
 *
 * Under shop `mode: "pilot"` the Functions treat a product's policy like this:
 *   - metafield absent                    -> not enforced, native price
 *   - `required: false`                   -> not enforced, native price
 *   - `active: false`                     -> checkout BLOCKED ("product_policy_inactive")
 *   - `required: true`, `active: true`    -> enforced
 *
 * so the two ways to take a product out of the pilot behave differently:
 *   mode "inactive"   (default) sets `active:false`: fail-closed, the product cannot be bought.
 *   mode "unrequired"           sets `required:false`: the product is simply not enforced.
 *
 *  plan      read-only: DB selects and Shopify QUERIES.
 *  apply     refuses while shop enforcement is enabled, refuses unless the rebuilt plan hashes to
 *            the approved one, writes a manifest first, then edits each product's metafield with
 *            the live digest as the compare token, in batches, verifying each batch by re-reading.
 *            The first conflict or surprise stops the run.
 *  rollback  restores each product's previous value, only where the metafield is still exactly
 *            what this run wrote.
 *
 * Only the product `pricing_policy` metafield is written. No database row, no override, no shop
 * policy and no other product is touched.
 */

export type ScopeMode = "inactive" | "unrequired";

export interface ScopeRow {
  productGid: string;
  profileId: string;
  profileRevision: number;
  liveDigest: string;
  beforeJson: string;
  afterJson: string;
}

export interface ScopePlan {
  shop: string;
  storeId: string;
  mode: ScopeMode;
  keep: string[];
  enforcement: { enabled: boolean | null; applyBlocked: boolean; reason: string | null };
  rows: ScopeRow[];
  kept: Array<{ productGid: string; json: string; liveDigest: string }>;
  blocked: Array<{ productGid: string; reason: string }>;
  totals: { overrides: number; change: number; keep: number; blocked: number; blockedByReason: Record<string, number> };
  hash: string;
}

export interface ScopeContract {
  change: number;
  keep: string[];
  blocked: number;
}

export type ScopeStatus = "planned" | "done" | "failed" | "skipped";

export interface ScopeManifest {
  version: 1;
  kind: "pilot-scope";
  createdAt: string;
  shop: string;
  storeId: string;
  mode: ScopeMode;
  planHash: string;
  state: "planned" | "applying" | "completed" | "aborted" | "rolled_back";
  abortedBecause?: string[];
  entries: Array<ScopeRow & { status: ScopeStatus; postDigest?: string; error?: string; rolledBack?: string }>;
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
const toGid = (key: string) => (key.startsWith("gid://") ? key : `gid://shopify/Product/${key}`);
const BATCH = Math.min(METAFIELDS_SET_MAX, 25);

const policyJson = (profileId: string, profileRevision: number, flags: { required?: boolean; active?: boolean } = {}) =>
  canonicalPolicyJson(buildProductPolicyValue({ profileId, profileRevision, policyRevision: 1, ...flags }));

export async function buildScopePlan(deps: {
  prisma: PrismaClient;
  port: CatalogWritePort;
  storeId: string;
  shop: string;
  keep: string[];
  mode?: ScopeMode;
  shopPolicyJson: unknown;
}): Promise<ScopePlan> {
  const { prisma, port, storeId, shop } = deps;
  const mode = deps.mode ?? "inactive";
  const keep = [...new Set(deps.keep.map(toGid))].sort();
  if (keep.length === 0) throw new Error("name at least one product to keep");

  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { shopDomain: true } });
  if (!store || store.shopDomain !== shop) throw new Error("the store id does not belong to the confirmed shop");

  const gate = checkEnforcementDisabled(deps.shopPolicyJson);
  const enabled = deps.shopPolicyJson && typeof deps.shopPolicyJson === "object" ? Boolean((deps.shopPolicyJson as { enabled?: unknown }).enabled) : null;
  const enforcement = { enabled, applyBlocked: !gate.ok, reason: gate.ok ? null : gate.message };

  const overrides = await prisma.productPricingOverride.findMany({ where: { storeId, isActive: true }, select: { shopifyProductId: true, pricingProfileId: true } });
  const byGid = new Map(overrides.map((o) => [toGid(o.shopifyProductId), o.pricingProfileId]));
  const gids = [...byGid.keys()].sort();
  const profiles = new Map((await prisma.pricingProfile.findMany({ where: { storeId }, select: { id: true, revision: true, isActive: true } })).map((p) => [p.id, p]));

  const blocked: ScopePlan["blocked"] = [];
  const rows: ScopeRow[] = [];
  const kept: ScopePlan["kept"] = [];
  for (const k of keep) if (!byGid.has(k)) blocked.push({ productGid: k, reason: "keep_product_has_no_active_override" });

  for (let i = 0; i < gids.length; i += 100) {
    const chunk = gids.slice(i, i + 100);
    const reads = await port.readProductPolicies(chunk);
    for (const gid of chunk) {
      const block = (reason: string) => blocked.push({ productGid: gid, reason });
      const profile = profiles.get(byGid.get(gid) ?? "");
      if (!profile) { block("profile_missing"); continue; }
      const read = reads.get(gid);
      if (!read?.present || !read.compareDigest) { block("policy_absent"); continue; }
      const live = normalizeExistingPolicyJson(read.jsonValue);
      const expected = policyJson(profile.id, profile.revision);
      if (live !== expected) { block(keep.includes(gid) ? "keep_policy_not_active_and_required" : "policy_differs"); continue; }
      if (keep.includes(gid)) { kept.push({ productGid: gid, json: live, liveDigest: read.compareDigest }); continue; }
      rows.push({
        productGid: gid,
        profileId: profile.id,
        profileRevision: profile.revision,
        liveDigest: read.compareDigest,
        beforeJson: live,
        afterJson: policyJson(profile.id, profile.revision, mode === "inactive" ? { active: false } : { required: false }),
      });
    }
  }

  const blockedByReason: Record<string, number> = {};
  for (const b of blocked) blockedByReason[b.reason] = (blockedByReason[b.reason] ?? 0) + 1;
  const hash = createHash("sha256")
    .update(stable({ shop, storeId, mode, keep, rows: rows.map((r) => [r.productGid, r.profileId, r.profileRevision, r.liveDigest, r.beforeJson, r.afterJson]), kept, blocked }))
    .digest("hex");
  return {
    shop, storeId, mode, keep, enforcement, rows, kept, blocked,
    totals: { overrides: gids.length, change: rows.length, keep: kept.length, blocked: blocked.length, blockedByReason },
    hash,
  };
}

export function checkScopeContract(plan: ScopePlan, contract: ScopeContract): string[] {
  const problems: string[] = [];
  if (plan.totals.change !== contract.change) problems.push(`change: expected ${contract.change}, got ${plan.totals.change}`);
  if (plan.totals.blocked !== contract.blocked) problems.push(`blocked: expected ${contract.blocked}, got ${plan.totals.blocked} (${JSON.stringify(plan.totals.blockedByReason)})`);
  if (stable(plan.keep) !== stable([...contract.keep].sort())) problems.push(`keep set differs: ${JSON.stringify(plan.keep)}`);
  if (plan.kept.length !== contract.keep.length) problems.push(`kept products found: ${plan.kept.length}, expected ${contract.keep.length}`);
  return problems;
}

type ApplyResult = { state: ScopeManifest["state"] | "refused"; refusedBecause?: string[]; abortedBecause?: string[]; changed: number; manifest?: ScopeManifest };

export async function applyScopePlan(deps: {
  prisma: PrismaClient;
  port: CatalogWritePort;
  storeId: string;
  shop: string;
  keep: string[];
  mode?: ScopeMode;
  approvedHash: string;
  readShopPolicyJson: () => Promise<unknown>;
  onManifest: (m: ScopeManifest) => Promise<void>;
  now?: () => Date;
}): Promise<ApplyResult> {
  const { prisma, port, storeId, shop } = deps;

  const shopPolicy0 = await deps.readShopPolicyJson();
  const gate0 = checkEnforcementDisabled(shopPolicy0);
  if (!gate0.ok) return { state: "refused", refusedBecause: [gate0.message], changed: 0 };

  const plan = await buildScopePlan({ prisma, port, storeId, shop, keep: deps.keep, mode: deps.mode, shopPolicyJson: shopPolicy0 });
  if (plan.hash !== deps.approvedHash) return { state: "refused", refusedBecause: ["the live plan no longer matches the approved plan (hash differs); re-run plan mode and review again"], changed: 0 };
  if (plan.totals.blocked > 0) return { state: "refused", refusedBecause: [`the plan has ${plan.totals.blocked} blocked row(s): ${JSON.stringify(plan.totals.blockedByReason)}`], changed: 0 };

  const manifest: ScopeManifest = {
    version: 1, kind: "pilot-scope", createdAt: (deps.now?.() ?? new Date()).toISOString(), shop, storeId, mode: plan.mode, planHash: plan.hash, state: "planned",
    entries: plan.rows.map((r) => ({ ...r, status: "planned" as ScopeStatus })),
  };
  await deps.onManifest(manifest); // BEFORE the first Shopify write: the audit and rollback record
  manifest.state = "applying";

  const abort = async (why: string): Promise<ApplyResult> => {
    manifest.state = "aborted";
    manifest.abortedBecause = [why];
    for (const e of manifest.entries) if (e.status === "planned") e.status = "skipped";
    await deps.onManifest(manifest);
    return { state: "aborted", abortedBecause: [why], changed: manifest.entries.filter((e) => e.status === "done").length, manifest };
  };

  for (let i = 0; i < manifest.entries.length; i += BATCH) {
    const batch = manifest.entries.slice(i, i + BATCH);

    // fresh gate and fresh digests before EVERY batch
    const gate = checkEnforcementDisabled(await deps.readShopPolicyJson());
    if (!gate.ok) return abort(`stopped before batch ${i / BATCH + 1}: ${gate.message}`);
    const live = await port.readProductPolicies(batch.map((e) => e.productGid));
    for (const e of batch) {
      const r = live.get(e.productGid);
      if (!r?.present || r.compareDigest !== e.liveDigest) { e.status = "failed"; e.error = "metafield changed since the plan"; return abort(`${e.productGid}: the live policy metafield changed since the plan; nothing written for this batch`); }
    }

    const outcomes = await port.setProductPolicies(batch.map((e) => ({ productGid: e.productGid, valueJson: e.afterJson, compareDigest: e.liveDigest })));
    let failure: string | null = null;
    for (const e of batch) {
      const o = outcomes.get(e.productGid);
      if (o && o.ok) { e.status = "done"; e.postDigest = o.compareDigest ?? undefined; }
      else { e.status = "failed"; e.error = o ? ("conflict" in o && o.conflict ? "conflict" : o.message) : "no result returned"; failure ??= `${e.productGid}: ${e.error}`; }
    }
    // verify what Shopify now holds for the rows that reported success
    const after = await port.readProductPolicies(batch.filter((e) => e.status === "done").map((e) => e.productGid));
    for (const e of batch) {
      if (e.status !== "done") continue;
      const r = after.get(e.productGid);
      if (!r?.present || normalizeExistingPolicyJson(r.jsonValue) !== e.afterJson) { e.status = "failed"; e.error = "verification read does not show the written value"; failure ??= `${e.productGid}: ${e.error}`; }
      else e.postDigest = r.compareDigest ?? e.postDigest;
    }
    await deps.onManifest(manifest);
    if (failure) return abort(failure);
  }

  manifest.state = "completed";
  await deps.onManifest(manifest);
  return { state: "completed", changed: manifest.entries.length, manifest };
}

export async function rollbackScope(deps: {
  port: CatalogWritePort;
  storeId: string;
  shop: string;
  manifest: ScopeManifest;
  onManifest: (m: ScopeManifest) => Promise<void>;
}): Promise<{ restored: number; skipped: string[] }> {
  const { manifest, port } = deps;
  if (manifest.shop !== deps.shop || manifest.storeId !== deps.storeId) throw new Error("the manifest belongs to a different shop or store");
  const done = manifest.entries.filter((e) => e.status === "done");
  let restored = 0;
  const skipped: string[] = [];
  for (let i = 0; i < done.length; i += BATCH) {
    const batch = done.slice(i, i + BATCH);
    const live = await port.readProductPolicies(batch.map((e) => e.productGid));
    const ready: typeof batch = [];
    for (const e of batch) {
      const r = live.get(e.productGid);
      // only where the metafield is still exactly what this run wrote
      if (r?.present && r.compareDigest && normalizeExistingPolicyJson(r.jsonValue) === e.afterJson && (!e.postDigest || r.compareDigest === e.postDigest)) { ready.push(e); e.postDigest = r.compareDigest; }
      else { e.rolledBack = "skipped: the metafield changed after this run wrote it"; skipped.push(`${e.productGid}: changed after this run; left alone`); }
    }
    if (!ready.length) continue;
    const outcomes = await port.setProductPolicies(ready.map((e) => ({ productGid: e.productGid, valueJson: e.beforeJson, compareDigest: e.postDigest! })));
    for (const e of ready) {
      const o = outcomes.get(e.productGid);
      if (o && o.ok) { e.rolledBack = "restored"; restored += 1; }
      else { e.rolledBack = `skipped: ${o ? ("conflict" in o && o.conflict ? "conflict" : o.message) : "no result"}`; skipped.push(`${e.productGid}: ${e.rolledBack}`); }
    }
  }
  manifest.state = "rolled_back";
  await deps.onManifest(manifest);
  return { restored, skipped };
}
