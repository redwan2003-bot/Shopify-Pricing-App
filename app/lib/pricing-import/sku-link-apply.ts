import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { adminRequest, METAFIELDS_SET_MAX, type AdminGraphqlClientLike } from "../catalog/admin-client.ts";
import { createAdminWritePort, type PolicyRead, type PolicyWriteOutcome } from "../catalog/write-port.ts";
import { overrideProductKey } from "../catalog/gid.ts";
import { buildLinkReport, classifyPolicy, expectedPolicyJson, type OverrideAction, type PolicyStatus } from "./link-products.ts";

/**
 * Guarded, auditable, reversible application of the SKU auto-link.
 *
 *  plan      rebuild the live report and snapshot every product's current policy metafield
 *            (value + Shopify compare-and-set digest). Writes nothing.
 *  apply     refuses unless the freshly rebuilt plan hashes to the plan a human approved.
 *            Writes a manifest BEFORE the first mutation; then, batch by batch, re-verifies
 *            store identity, profile revisions, current metafield digests, override state and
 *            product status, writes policies compare-and-set, and creates bare-keyed overrides.
 *            Any drift or failed write stops the run; nothing after it is attempted.
 *  rollback  restores each written product's previous metafield value (or removes a metafield
 *            this run created) only if the live digest is still the one this run wrote, and
 *            removes only the override rows this run created.
 */

export const PRODUCT_STATUS_QUERY = `#graphql
  query ImprintIdProductStatus($ids: [ID!]!) {
    nodes(ids: $ids) { __typename ... on Product { id status } }
  }`;

export const SHOP_IDENTITY_QUERY = `#graphql
  query ImprintIdShopIdentity { shop { myshopifyDomain } }`;

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

export interface PlanEntry {
  sku: string | null;
  productGid: string;
  productId: string;
  profileId: string;
  profileRevision: number;
  /** canonical policy JSON this run would write */
  expectedPolicy: string;
  manual: boolean;
  previous: { present: boolean; jsonValue: unknown; compareDigest: string | null };
  policyStatus: PolicyStatus;
  willWritePolicy: boolean;
  overrideAction: OverrideAction;
  fromProfileId: string | null;
  legacyGidRow: boolean;
  bareKey: string;
}

export interface SkuLinkPlan {
  shop: string;
  storeId: string;
  resolutions: Record<string, string>;
  entries: PlanEntry[];
  heldBack: { sku: string | null; reason: string }[];
  totals: {
    matched: number;
    heldBack: number;
    blocked: number;
    policyWrites: number;
    stale: number;
    missing: number;
    malformed: number;
    alreadyCorrect: number;
    overridesToCreate: number;
    overridesToUpdate: number;
    overridesUnchanged: number;
    legacyGidRows: number;
  };
  /** SHA-256 over everything a human approves; changes if ANY live fact the plan depends on changes */
  hash: string;
}

export type EntryStatus = "planned" | "done" | "failed" | "skipped";

export interface ManifestEntry extends PlanEntry {
  status: EntryStatus;
  policyWritten?: boolean;
  digestAfter?: string | null;
  overrideCreated?: boolean;
  overrideUpdated?: boolean;
  error?: string;
  rolledBack?: string;
}

export interface Manifest {
  version: 1;
  kind: "sku-link";
  createdAt: string;
  shop: string;
  storeId: string;
  planHash: string;
  resolutions: Record<string, string>;
  state: "planned" | "applying" | "completed" | "aborted" | "rolled_back";
  abortedBecause?: string[];
  entries: ManifestEntry[];
}

export interface Deps {
  prisma: PrismaClient;
  admin: AdminGraphqlClientLike;
  shop: string;
  storeId: string;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const BATCH = METAFIELDS_SET_MAX;

async function assertStoreIdentity(deps: Deps): Promise<string[]> {
  const problems: string[] = [];
  const store = await deps.prisma.store.findUnique({ where: { id: deps.storeId }, select: { shopDomain: true } });
  if (!store || store.shopDomain !== deps.shop) problems.push("the database store row is not the confirmed shop");
  const data = await adminRequest(deps.admin, SHOP_IDENTITY_QUERY);
  const domain = (data.shop as { myshopifyDomain?: string } | undefined)?.myshopifyDomain;
  if (domain !== deps.shop) problems.push(`Shopify answered for a different shop than the confirmed one`);
  return problems;
}

// ---------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------

export async function buildSkuLinkPlan(deps: Deps & { resolutions: Record<string, string> }): Promise<SkuLinkPlan> {
  const port = createAdminWritePort(deps.admin);
  const report = await buildLinkReport(deps.prisma, deps.admin, deps.storeId, { manualResolutions: deps.resolutions });
  const planByGid = new Map(report.overridePlan.map((e) => [e.productGid, e]));

  const reads = new Map<string, PolicyRead>();
  for (const batch of chunks(report.matched.map((m) => m.productGid), BATCH)) {
    for (const [gid, read] of await port.readProductPolicies(batch)) reads.set(gid, read);
  }

  const entries: PlanEntry[] = report.matched.map((m) => {
    const read = reads.get(m.productGid);
    const previous = { present: read?.present ?? false, jsonValue: read?.present ? read.jsonValue : null, compareDigest: read?.compareDigest ?? null };
    const expectedPolicy = expectedPolicyJson(m);
    const policyStatus = classifyPolicy(expectedPolicy, previous.present ? previous.jsonValue : null);
    const override = planByGid.get(m.productGid);
    const action = override?.action ?? "blocked";
    return {
      sku: m.profile.sku,
      productGid: m.productGid,
      productId: m.productGid.split("/").pop() ?? m.productGid,
      profileId: m.profile.id,
      profileRevision: m.profile.revision,
      expectedPolicy,
      manual: m.manual === true,
      previous,
      policyStatus,
      willWritePolicy: policyStatus !== "ok" && action !== "blocked",
      overrideAction: action,
      fromProfileId: override?.fromProfileId ?? null,
      legacyGidRow: override?.legacyGidRow === true,
      bareKey: override?.bareKey ?? overrideProductKey(m.productGid) ?? "",
    };
  });
  entries.sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

  const count = (f: (e: PlanEntry) => boolean) => entries.filter(f).length;
  const totals: SkuLinkPlan["totals"] = {
    matched: entries.length,
    heldBack: report.heldBack.length,
    blocked: count((e) => e.overrideAction === "blocked"),
    policyWrites: count((e) => e.willWritePolicy),
    stale: count((e) => e.willWritePolicy && e.policyStatus === "stale"),
    missing: count((e) => e.willWritePolicy && e.policyStatus === "missing"),
    malformed: count((e) => e.willWritePolicy && e.policyStatus === "malformed"),
    alreadyCorrect: count((e) => e.policyStatus === "ok"),
    overridesToCreate: count((e) => e.overrideAction === "create"),
    overridesToUpdate: count((e) => e.overrideAction === "update"),
    overridesUnchanged: count((e) => e.overrideAction === "unchanged"),
    legacyGidRows: count((e) => e.legacyGidRow),
  };

  const heldBack = [...report.heldBack].sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
  const hash = createHash("sha256")
    .update(stable({ shop: deps.shop, storeId: deps.storeId, resolutions: deps.resolutions, entries, heldBack }))
    .digest("hex");
  return { shop: deps.shop, storeId: deps.storeId, resolutions: deps.resolutions, entries, heldBack, totals, hash };
}

// ---------------------------------------------------------------------------------------
// Contract (what the reviewer approved) and comparison with a saved preview
// ---------------------------------------------------------------------------------------

export interface PlanContract {
  matched: number;
  heldBackSkus: string[];
  staleWrites: number;
  missingWrites: number;
  overridesToCreate: number;
  overridesUnchanged: number;
  blocked: number;
  legacyGidRows: number;
}

export function checkContract(plan: SkuLinkPlan, c: PlanContract): string[] {
  const t = plan.totals;
  const problems: string[] = [];
  const eq = (name: string, got: number, want: number) => got !== want && problems.push(`${name}: expected ${want}, got ${got}`);
  eq("matched", t.matched, c.matched);
  eq("stale policy writes", t.stale, c.staleWrites);
  eq("missing policy writes", t.missing, c.missingWrites);
  eq("malformed policy writes", t.malformed, 0);
  eq("overrides to create", t.overridesToCreate, c.overridesToCreate);
  eq("overrides to update", t.overridesToUpdate, 0);
  eq("overrides unchanged", t.overridesUnchanged, c.overridesUnchanged);
  eq("blocked", t.blocked, c.blocked);
  eq("legacy GID rows", t.legacyGidRows, c.legacyGidRows);
  const skus = plan.heldBack.map((h) => String(h.sku)).sort();
  if (stable(skus) !== stable([...c.heldBackSkus].sort())) problems.push(`held back SKUs: expected ${c.heldBackSkus.join(",")}, got ${skus.join(",")}`);
  if (!plan.heldBack.every((h) => /only archived/.test(h.reason))) problems.push("a held-back SKU is held back for a reason other than 'only archived products carry this SKU'");
  return problems;
}

interface PreviewFile {
  matched: { sku: string | null; productId: string; manualResolution: boolean }[];
  heldBack: { sku: string | null; reason: string }[];
  blocked: unknown[];
  proposedShopifyWrites: { sku: string | null; productId: string; reason: string }[];
  proposedOverrideChanges: { sku: string | null; key: string; action: string; profileId: string }[];
  overridesUnchanged: { sku: string | null; key: string }[];
}

/** Exact, list-level comparison with a previously reviewed preview report. */
export function diffAgainstPreview(plan: SkuLinkPlan, preview: PreviewFile): string[] {
  const problems: string[] = [];
  const same = (name: string, got: string[], want: string[]) => {
    const g = new Set(got);
    const w = new Set(want);
    const extra = got.filter((x) => !w.has(x));
    const missing = want.filter((x) => !g.has(x));
    if (got.length !== want.length || extra.length || missing.length) {
      problems.push(`${name}: ${extra.length} not in the preview (e.g. ${extra[0] ?? "-"}), ${missing.length} missing from the plan (e.g. ${missing[0] ?? "-"})`);
    }
  };
  same("matched", plan.entries.map((e) => `${e.sku}|${e.productId}|${e.manual}`), preview.matched.map((m) => `${m.sku}|${m.productId}|${m.manualResolution}`));
  same("held back", plan.heldBack.map((h) => `${h.sku}|${h.reason}`), preview.heldBack.map((h) => `${h.sku}|${h.reason}`));
  same("blocked", plan.entries.filter((e) => e.overrideAction === "blocked").map((e) => e.productId), (preview.blocked as { productId: string }[]).map((b) => b.productId));
  same("policy writes", plan.entries.filter((e) => e.willWritePolicy).map((e) => `${e.sku}|${e.productId}|${e.policyStatus}`), preview.proposedShopifyWrites.map((w) => `${w.sku}|${w.productId}|${w.reason}`));
  same(
    "override changes",
    plan.entries.filter((e) => e.overrideAction === "create" || e.overrideAction === "update").map((e) => `${e.sku}|${e.bareKey}|${e.overrideAction}|${e.profileId}`),
    preview.proposedOverrideChanges.map((c) => `${c.sku}|${c.key}|${c.action}|${c.profileId}`),
  );
  same("unchanged overrides", plan.entries.filter((e) => e.overrideAction === "unchanged").map((e) => `${e.sku}|${e.bareKey}`), preview.overridesUnchanged.map((u) => `${u.sku}|${u.key}`));
  return problems;
}

// ---------------------------------------------------------------------------------------
// Per-batch verification
// ---------------------------------------------------------------------------------------

async function verifyBatch(deps: Deps, batch: ManifestEntry[]): Promise<string[]> {
  const problems: string[] = [];
  const label = (e: ManifestEntry) => `${e.sku} (${e.productId})`;
  problems.push(...(await assertStoreIdentity(deps)));

  // Profile revisions: the policy JSON was derived from id + revision.
  const profiles = await deps.prisma.pricingProfile.findMany({
    where: { storeId: deps.storeId, id: { in: batch.map((e) => e.profileId) } },
    select: { id: true, sku: true, revision: true, isActive: true },
  });
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  for (const e of batch) {
    const p = profileById.get(e.profileId);
    if (!p) problems.push(`${label(e)}: the pricing profile no longer exists`);
    else if (p.revision !== e.profileRevision) problems.push(`${label(e)}: profile revision changed (${e.profileRevision} -> ${p.revision})`);
    else if (p.sku !== e.sku || !p.isActive) problems.push(`${label(e)}: the profile's SKU or active flag changed`);
  }

  // Current metafield digests: must be exactly what was planned.
  const port = createAdminWritePort(deps.admin);
  const reads = await port.readProductPolicies(batch.map((e) => e.productGid));
  for (const e of batch) {
    const r = reads.get(e.productGid);
    if (!r || r.present !== e.previous.present || r.compareDigest !== e.previous.compareDigest) {
      problems.push(`${label(e)}: the policy metafield changed since the plan was approved`);
    }
  }

  // Product status.
  const status = await adminRequest(deps.admin, PRODUCT_STATUS_QUERY, { ids: batch.map((e) => e.productGid) });
  const statusById = new Map<string, string>();
  for (const node of (status.nodes ?? []) as ({ id?: string; status?: string } | null)[]) if (node?.id && node.status) statusById.set(node.id, node.status);
  for (const e of batch) if (statusById.get(e.productGid) !== "ACTIVE") problems.push(`${label(e)}: the product is not ACTIVE (${statusById.get(e.productGid) ?? "not found"})`);

  // Override state: both key forms.
  const keys = batch.flatMap((e) => [e.bareKey, e.productGid]);
  const rows = await deps.prisma.productPricingOverride.findMany({
    where: { storeId: deps.storeId, shopifyProductId: { in: keys } },
    select: { shopifyProductId: true, pricingProfileId: true, isActive: true },
  });
  const rowByKey = new Map(rows.map((r) => [r.shopifyProductId, r]));
  for (const e of batch) {
    const bare = rowByKey.get(e.bareKey);
    const legacy = rowByKey.get(e.productGid);
    if (Boolean(legacy) !== e.legacyGidRow) problems.push(`${label(e)}: a legacy GID-keyed override appeared or disappeared`);
    if (e.overrideAction === "create" && bare) problems.push(`${label(e)}: a bare-keyed override already exists`);
    if (e.overrideAction === "unchanged" && !(bare && bare.pricingProfileId === e.profileId && bare.isActive)) problems.push(`${label(e)}: the existing override no longer matches`);
    if (e.overrideAction === "update" && !(bare && bare.pricingProfileId === e.fromProfileId)) problems.push(`${label(e)}: the override to update has changed`);
    if (e.overrideAction === "blocked") problems.push(`${label(e)}: blocked by an override-key conflict`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------

export interface ApplyResult {
  state: Manifest["state"];
  refusedBecause?: string[];
  abortedBecause?: string[];
  policiesWritten: number;
  overridesCreated: number;
  manifest?: Manifest;
}

export async function applySkuLinkPlan(
  deps: Deps & { resolutions: Record<string, string>; approvedHash: string; onManifest: (m: Manifest) => Promise<void>; now?: () => Date },
): Promise<ApplyResult> {
  const identity = await assertStoreIdentity(deps);
  if (identity.length) return { state: "aborted", refusedBecause: identity, policiesWritten: 0, overridesCreated: 0 };

  // Rebuild from live state. If anything the reviewer approved has moved, refuse.
  const plan = await buildSkuLinkPlan(deps);
  if (plan.hash !== deps.approvedHash) {
    return { state: "aborted", refusedBecause: ["the live plan no longer matches the approved plan (hash differs); re-run plan mode and review again"], policiesWritten: 0, overridesCreated: 0 };
  }
  const blocked = plan.entries.filter((e) => e.overrideAction === "blocked");
  if (blocked.length) return { state: "aborted", refusedBecause: [`${blocked.length} product(s) are blocked by override-key conflicts`], policiesWritten: 0, overridesCreated: 0 };

  const manifest: Manifest = {
    version: 1,
    kind: "sku-link",
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    shop: deps.shop,
    storeId: deps.storeId,
    planHash: plan.hash,
    resolutions: deps.resolutions,
    state: "planned",
    entries: plan.entries.map((e) => ({ ...e, status: "planned" as EntryStatus })),
  };
  await deps.onManifest(manifest); // BEFORE the first mutation: the audit and rollback record
  manifest.state = "applying";

  const port = createAdminWritePort(deps.admin);
  let policiesWritten = 0;
  let overridesCreated = 0;
  const work = manifest.entries.filter((e) => e.willWritePolicy || e.overrideAction === "create" || e.overrideAction === "update");
  const abort = async (why: string[]): Promise<ApplyResult> => {
    manifest.state = "aborted";
    manifest.abortedBecause = why;
    for (const e of manifest.entries) if (e.status === "planned") e.status = "skipped";
    await deps.onManifest(manifest);
    return { state: "aborted", abortedBecause: why, policiesWritten, overridesCreated, manifest };
  };

  for (const batch of chunks(work, BATCH)) {
    const problems = await verifyBatch(deps, batch);
    if (problems.length) return abort(problems);

    const toWrite = batch.filter((e) => e.willWritePolicy);
    const outcomes: Map<string, PolicyWriteOutcome> = toWrite.length
      ? await port.setProductPolicies(toWrite.map((e) => ({ productGid: e.productGid, valueJson: e.expectedPolicy, compareDigest: e.previous.compareDigest })))
      : new Map();

    const failures: string[] = [];
    for (const e of batch) {
      if (e.willWritePolicy) {
        const outcome = outcomes.get(e.productGid);
        if (outcome?.ok) {
          e.policyWritten = true;
          e.digestAfter = outcome.compareDigest;
          policiesWritten += 1;
        } else {
          e.status = "failed";
          e.error = outcome ? `${outcome.code}: ${outcome.message}` : "no outcome returned";
          failures.push(`${e.sku} (${e.productId}): ${e.error}`);
          continue;
        }
      }
      try {
        if (e.overrideAction === "create") {
          await deps.prisma.productPricingOverride.create({ data: { storeId: deps.storeId, shopifyProductId: e.bareKey, pricingProfileId: e.profileId, isActive: true } });
          e.overrideCreated = true;
          overridesCreated += 1;
        } else if (e.overrideAction === "update") {
          const res = await deps.prisma.productPricingOverride.updateMany({
            where: { storeId: deps.storeId, shopifyProductId: e.bareKey, pricingProfileId: e.fromProfileId },
            data: { pricingProfileId: e.profileId, isActive: true },
          });
          if (res.count !== 1) throw new Error("the override to update was not found");
          e.overrideUpdated = true;
        }
        e.status = "done";
      } catch (error) {
        e.status = "failed";
        e.error = `override: ${error instanceof Error ? error.message.split("\n").slice(-1)[0] : "failed"}`.slice(0, 200);
        failures.push(`${e.sku} (${e.productId}): ${e.error}`);
      }
    }
    await deps.onManifest(manifest);
    if (failures.length) return abort(failures);
  }

  manifest.state = "completed";
  for (const e of manifest.entries) if (e.status === "planned") e.status = "done"; // nothing to do for this product
  await deps.onManifest(manifest);
  return { state: "completed", policiesWritten, overridesCreated, manifest };
}

// ---------------------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------------------

export interface RollbackResult {
  restored: number;
  removedMetafields: number;
  overridesRemoved: number;
  skipped: string[];
}

export async function rollbackSkuLink(deps: Deps & { manifest: Manifest; onManifest: (m: Manifest) => Promise<void> }): Promise<RollbackResult> {
  const { manifest } = deps;
  if (manifest.shop !== deps.shop || manifest.storeId !== deps.storeId) throw new Error("the manifest belongs to a different shop or store");
  const identity = await assertStoreIdentity(deps);
  if (identity.length) throw new Error(identity.join("; "));

  const port = createAdminWritePort(deps.admin);
  const result: RollbackResult = { restored: 0, removedMetafields: 0, overridesRemoved: 0, skipped: [] };

  for (const e of [...manifest.entries].reverse()) {
    const label = `${e.sku} (${e.productId})`;
    if (e.overrideCreated) {
      const res = await deps.prisma.productPricingOverride.deleteMany({ where: { storeId: deps.storeId, shopifyProductId: e.bareKey, pricingProfileId: e.profileId } });
      if (res.count === 1) result.overridesRemoved += 1;
      else result.skipped.push(`${label}: the override row this run created was not found as written; left alone`);
    }
    if (e.policyWritten) {
      const current = (await port.readProductPolicies([e.productGid])).get(e.productGid);
      if (!current?.present || current.compareDigest !== e.digestAfter) {
        e.rolledBack = "skipped: metafield changed since this run wrote it";
        result.skipped.push(`${label}: the policy metafield changed after this run wrote it; left alone`);
        continue;
      }
      if (e.previous.present) {
        const out = (await port.setProductPolicies([{ productGid: e.productGid, valueJson: JSON.stringify(e.previous.jsonValue), compareDigest: e.digestAfter ?? null }])).get(e.productGid);
        if (out?.ok) {
          e.rolledBack = "restored";
          result.restored += 1;
        } else {
          e.rolledBack = "failed";
          result.skipped.push(`${label}: restore failed (${out && !out.ok ? out.code : "no outcome"})`);
        }
      } else {
        const out = await port.deleteProductPolicy(e.productGid, e.digestAfter ?? null);
        if (out.ok) {
          e.rolledBack = "removed";
          result.removedMetafields += 1;
        } else {
          e.rolledBack = "failed";
          result.skipped.push(`${label}: removal failed (${out.code})`);
        }
      }
    }
  }
  manifest.state = "rolled_back";
  await deps.onManifest(manifest);
  return result;
}
