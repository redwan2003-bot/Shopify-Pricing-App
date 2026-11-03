import type { PrismaClient } from "@prisma/client";
import type { AdminGraphqlClientLike } from "../pricing-api/product-resolver.ts";
import { buildProductPolicyValue, canonicalPolicyJson, normalizeExistingPolicyJson } from "../catalog/policy-value.ts";
import { overrideProductKey, parseProductGid } from "../catalog/gid.ts";
import { classifyOverrideKeyState } from "../catalog/override-key-audit.ts";
import { reconcileCoverageForProducts, type BestEffortReconcile } from "../catalog/coverage.ts";
import { parseProductPricingPolicy, parseShopEnforcementPolicy } from "../pricing-api/policy-metafields.ts";

/**
 * Links each pricing profile to its Shopify product by SKU: a profile with sku "LDSPK" matches
 * the one product whose variant SKUs start with "LDSPK_" (the catalog's `{SKU}_{Color}`
 * convention) or equal "LDSPK". For each match it writes the app-owned
 * `$app:imprintid/pricing_policy` product metafield (profile id + revision — what the Functions
 * check a quote against) and a local ProductPricingOverride row.
 *
 * Products whose metafield is already correct are skipped, so this is safe to re-run; it must
 * be re-run after any import that changes pricing, because a change bumps the profile revision.
 * A SKU with no matching product, or several, is reported rather than guessed.
 *
 * Overrides are keyed by the BARE numeric product id (`overrideProductKey`), the form the
 * storefront resolver and the catalog subsystem use. A legacy GID-keyed row is never rewritten
 * or deleted here; if one disagrees with what would be written, that product is blocked.
 *
 * `buildLinkReport` only READS (Shopify and the database). It is the preview: nothing is
 * written until `applyLinkReport` is called with its result.
 */

export const POLICY_REVISION = 1;
const METAFIELD_BATCH = 25;
const NODES_BATCH = 100;
const OVERRIDE_LOOKUP_BATCH = 500;

export type PolicyStatus = "ok" | "missing" | "stale" | "malformed";

export function classifyPolicy(expectedCanonicalJson: string, actualRaw: unknown): PolicyStatus {
  if (actualRaw === null || actualRaw === undefined) return "missing";
  let value = actualRaw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return "malformed";
    }
  }
  const actual = normalizeExistingPolicyJson(value);
  if (actual === "") return "malformed";
  return actual === expectedCanonicalJson ? "ok" : "stale";
}

export interface LinkCandidate {
  profile: { id: string; sku: string | null; revision: number };
  productGid: string;
  title?: string;
  /** true when the product was chosen by an explicit manual resolution, not by the SKU rule alone */
  manual?: boolean;
}

export function planPolicyWrites(
  matched: LinkCandidate[],
  existingByGid: Map<string, unknown>,
  expectedFor: (m: LinkCandidate) => string,
) {
  const counts: Record<PolicyStatus, number> = { ok: 0, missing: 0, stale: 0, malformed: 0 };
  const toWrite: LinkCandidate[] = [];
  const problems: { sku: string | null; productGid: string; status: PolicyStatus }[] = [];
  for (const m of matched) {
    const status = classifyPolicy(expectedFor(m), existingByGid.get(m.productGid));
    counts[status] += 1;
    if (status !== "ok") {
      toWrite.push(m);
      problems.push({ sku: m.profile.sku, productGid: m.productGid, status });
    }
  }
  return { counts, toWrite, problems };
}

export function expectedPolicyJson(m: LinkCandidate): string {
  return canonicalPolicyJson(
    buildProductPolicyValue({ profileId: m.profile.id, profileRevision: m.profile.revision, policyRevision: POLICY_REVISION }),
  );
}

export interface LinkShopPolicyState {
  enabled: boolean;
  policyRevision: number;
  /** False means the shop policy was absent or malformed, so planning used fail-safe defaults. */
  valid: boolean;
}

/**
 * Build the policy a linker write is allowed to make.
 *
 * Existing rollout flags are operational state, not pricing-import state, so importing a new
 * profile revision must never reset them. An already-enforced product follows the live shop
 * revision; inactive/unrequired products keep their existing revision because they are outside
 * the active rollout. A missing or malformed policy is fail-closed when enforcement is already
 * enabled and can only be made ready automatically while the shop gate is disabled.
 */
export function plannedPolicyJson(
  m: LinkCandidate,
  actualRaw: unknown,
  shopPolicy: LinkShopPolicyState,
): string {
  let existing: ReturnType<typeof parseProductPricingPolicy> = null;
  const normalized = normalizeExistingPolicyJson(actualRaw);
  if (normalized) {
    try {
      existing = parseProductPricingPolicy(JSON.parse(normalized));
    } catch {
      existing = null;
    }
  }
  const enforced = existing?.active === true && existing.required === true;
  return canonicalPolicyJson(
    buildProductPolicyValue({
      profileId: m.profile.id,
      profileRevision: m.profile.revision,
      policyRevision: enforced ? shopPolicy.policyRevision : (existing?.policyRevision ?? shopPolicy.policyRevision),
      required: existing?.required ?? true,
      active: existing?.active ?? !shopPolicy.enabled,
    }),
  );
}

// ---------------------------------------------------------------------------------------

const SKU_INDEX_QUERY = `#graphql
  query ImprintIdSkuIndex($cursor: String) {
    products(first: 100, after: $cursor) {
      edges { cursor node { id title status variants(first: 100) { edges { node { sku } } } } }
      pageInfo { hasNextPage }
    }
  }`;

const POLICY_READ_QUERY = `#graphql
  query ImprintIdPolicyRead($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id metafield(namespace: "$app:imprintid", key: "pricing_policy") { value } }
    }
  }`;

const SHOP_POLICY_READ_QUERY = `#graphql
  query ImprintIdShopPolicyRead {
    shop { metafield(namespace: "$app:imprintid", key: "enforcement_policy") { value } }
  }`;

const POLICY_WRITE = `#graphql
  mutation ImprintIdPolicyWrite($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
  }`;

async function gql(admin: AdminGraphqlClientLike, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const body = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
  if (!body.data) throw new Error("GraphQL response had no data");
  return body.data;
}

export async function fetchSkuIndex(admin: AdminGraphqlClientLike) {
  const index = new Map<string, Set<string>>();
  const titles = new Map<string, string>();
  const statuses = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const data = await gql(admin, SKU_INDEX_QUERY, { cursor });
    const products = data.products as {
      edges: { cursor: string; node: { id: string; title: string; status?: string; variants: { edges: { node: { sku: string | null } }[] } } }[];
      pageInfo: { hasNextPage: boolean };
    };
    for (const { node } of products.edges) {
      titles.set(node.id, node.title);
      if (node.status) statuses.set(node.id, node.status);
      for (const v of node.variants.edges) {
        const sku = v.node.sku;
        if (!sku) continue;
        const prefix = sku.split("_")[0]!.toUpperCase();
        if (!index.has(prefix)) index.set(prefix, new Set());
        index.get(prefix)!.add(node.id);
      }
    }
    if (!products.pageInfo.hasNextPage || products.edges.length === 0) break;
    cursor = products.edges[products.edges.length - 1]!.cursor;
  }
  return { index, titles, statuses };
}

async function fetchExistingPolicies(admin: AdminGraphqlClientLike, gids: string[]) {
  const existing = new Map<string, unknown>();
  for (let i = 0; i < gids.length; i += NODES_BATCH) {
    const data = await gql(admin, POLICY_READ_QUERY, { ids: gids.slice(i, i + NODES_BATCH) });
    for (const node of (data.nodes ?? []) as ({ id?: string; metafield?: { value: string } | null } | null)[]) {
      if (node?.id) existing.set(node.id, node.metafield ? node.metafield.value : null);
    }
  }
  return existing;
}

async function fetchShopPolicyState(admin: AdminGraphqlClientLike): Promise<LinkShopPolicyState> {
  const data = await gql(admin, SHOP_POLICY_READ_QUERY, {});
  const raw = (data.shop as { metafield?: { value?: unknown } | null } | undefined)?.metafield?.value;
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const parsed = parseShopEnforcementPolicy(value);
  if (parsed) {
    return { enabled: parsed.enabled, policyRevision: parsed.policyRevision, valid: true };
  }
  // If the shop gate cannot be understood, never make a newly linked product enforceable.
  return { enabled: true, policyRevision: POLICY_REVISION, valid: false };
}

// ---------------------------------------------------------------------------------------
// Local override plan
// ---------------------------------------------------------------------------------------

export type OverrideAction = "create" | "update" | "unchanged" | "blocked";

export interface OverridePlanEntry {
  sku: string | null;
  productGid: string;
  /** the key that will be written: the bare numeric product id */
  bareKey: string;
  profileId: string;
  action: OverrideAction;
  /** for `update`: the profile the bare-keyed row currently points at */
  fromProfileId?: string | null;
  /** a legacy GID-keyed row exists for this product (left untouched) */
  legacyGidRow?: boolean;
  /** why the entry is blocked */
  reason?: string;
}

type OverrideRow = { shopifyProductId: string; pricingProfileId: string | null; isActive: boolean; basePriceCents: number | null };

function sameRow(a: Omit<OverrideRow, "shopifyProductId">, b: Omit<OverrideRow, "shopifyProductId">): boolean {
  return (
    (a.pricingProfileId ?? null) === (b.pricingProfileId ?? null) &&
    a.isActive === b.isActive &&
    (a.basePriceCents ?? null) === (b.basePriceCents ?? null)
  );
}

async function planOverrides(prisma: PrismaClient, storeId: string, matched: LinkCandidate[]): Promise<OverridePlanEntry[]> {
  const keyed = matched.map((m) => ({ m, bareKey: overrideProductKey(m.productGid) }));
  const allKeys = keyed.flatMap(({ m, bareKey }) => (bareKey ? [bareKey, m.productGid] : [m.productGid]));
  const rowByKey = new Map<string, OverrideRow>();
  for (let i = 0; i < allKeys.length; i += OVERRIDE_LOOKUP_BATCH) {
    const rows = await prisma.productPricingOverride.findMany({
      where: { storeId, shopifyProductId: { in: allKeys.slice(i, i + OVERRIDE_LOOKUP_BATCH) } },
      select: { shopifyProductId: true, pricingProfileId: true, isActive: true, basePriceCents: true },
    });
    for (const r of rows) rowByKey.set(r.shopifyProductId, r);
  }

  return keyed.map(({ m, bareKey }): OverridePlanEntry => {
    const base = { sku: m.profile.sku, productGid: m.productGid, profileId: m.profile.id };
    if (!bareKey) return { ...base, bareKey: "", action: "blocked", reason: "the product id is not a valid Shopify product id" };

    const bare = rowByKey.get(bareKey);
    const legacy = rowByKey.get(m.productGid);
    const withLegacy = { ...base, bareKey, legacyGidRow: legacy ? true : undefined };

    if (classifyOverrideKeyState(bare, legacy) === "collision-conflict") {
      return { ...withLegacy, action: "blocked", reason: "the bare-keyed and a legacy GID-keyed override for this product disagree; resolve the duplicate first" };
    }
    // A legacy GID-keyed row that points somewhere else would become a conflicting twin of the row we write.
    const intended = { pricingProfileId: m.profile.id, isActive: true, basePriceCents: bare?.basePriceCents ?? null };
    if (legacy && !sameRow(legacy, intended)) {
      return { ...withLegacy, action: "blocked", reason: "a legacy GID-keyed override for this product points at a different profile; resolve it first" };
    }
    if (bare) {
      const unchanged = bare.pricingProfileId === m.profile.id && bare.isActive;
      return { ...withLegacy, action: unchanged ? "unchanged" : "update", fromProfileId: unchanged ? undefined : bare.pricingProfileId };
    }
    return { ...withLegacy, action: "create" };
  });
}

// ---------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------

export interface LinkOptions {
  /** Archived products are not link candidates unless this is true. */
  includeArchived?: boolean;
  /** Explicit decisions for SKUs that are ambiguous: profile SKU -> product id (bare or GID). */
  manualResolutions?: Record<string, string>;
}

export interface LinkReport {
  matched: LinkCandidate[];
  heldBack: { sku: string | null; reason: string }[];
  counts: Record<PolicyStatus, number>;
  /** Shopify policy writes still needed (blocked products excluded) */
  toWrite: LinkCandidate[];
  problems: { sku: string | null; productGid: string; status: PolicyStatus }[];
  /** matched products that already have an active override (bare- or GID-keyed) */
  overridesPresent: number;
  /** what applyLinkReport will do locally, per matched product */
  overridePlan: OverridePlanEntry[];
  /** matched products that will not be touched because of an override-key conflict */
  blocked: OverridePlanEntry[];
  /** Live shop rollout gate used to derive safe product-policy writes. */
  shopPolicy: LinkShopPolicyState;
  /** Canonical value for each writable matched product, preserving rollout state. */
  policyJsonByGid: Map<string, string>;
  /** Raw policy snapshot used by the activation-expansion guard. */
  policyBeforeByGid: Map<string, unknown>;
}

function normalizeResolutions(raw: Record<string, string> | undefined): { byKey: Map<string, string>; invalid: string[] } {
  const byKey = new Map<string, string>();
  const invalid: string[] = [];
  for (const [sku, value] of Object.entries(raw ?? {})) {
    const gid = parseProductGid(value);
    if (gid) byKey.set(sku.trim().toUpperCase(), gid);
    else invalid.push(sku);
  }
  return { byKey, invalid };
}

export async function buildLinkReport(
  prisma: PrismaClient,
  admin: AdminGraphqlClientLike,
  storeId: string,
  options: LinkOptions = {},
): Promise<LinkReport> {
  const { index, titles, statuses } = await fetchSkuIndex(admin);
  const profiles = await prisma.pricingProfile.findMany({ where: { storeId }, select: { id: true, sku: true, revision: true } });
  const resolutions = normalizeResolutions(options.manualResolutions);
  const savedOverrides = await prisma.productPricingOverride.findMany({
    where: { storeId, isActive: true, pricingProfileId: { not: null } },
    select: { shopifyProductId: true, pricingProfileId: true },
  });
  const savedProductsByProfile = new Map<string, Set<string>>();
  for (const row of savedOverrides) {
    if (!row.pricingProfileId) continue;
    const gid = parseProductGid(row.shopifyProductId);
    if (!gid) continue;
    if (!savedProductsByProfile.has(row.pricingProfileId)) savedProductsByProfile.set(row.pricingProfileId, new Set());
    savedProductsByProfile.get(row.pricingProfileId)!.add(gid);
  }

  const matched: LinkCandidate[] = [];
  const heldBack: LinkReport["heldBack"] = [];
  for (const sku of resolutions.invalid) {
    heldBack.push({ sku, reason: "the manual resolution is not a valid Shopify product id and was ignored" });
  }

  for (const profile of profiles) {
    const key = (profile.sku ?? "").toUpperCase();
    const all = index.get(key) ?? new Set<string>();
    const candidates = new Set([...all].filter((gid) => options.includeArchived || statuses.get(gid) !== "ARCHIVED"));

    const manual = resolutions.byKey.get(key);
    if (manual) {
      if (candidates.has(manual)) {
        matched.push({ profile, productGid: manual, title: titles.get(manual), manual: true });
      } else {
        const why = all.has(manual) ? "is archived" : "does not carry this SKU";
        heldBack.push({ sku: profile.sku, reason: `the manually chosen product ${manual.split("/").pop()} ${why}, so it cannot be linked` });
      }
      continue;
    }

    if (candidates.size === 0) {
      heldBack.push({
        sku: profile.sku,
        reason: all.size > 0 ? "only archived products carry this SKU" : "no product in the store has variant SKUs starting with this SKU",
      });
    } else if (candidates.size > 1) {
      const saved = [...candidates].filter((gid) => savedProductsByProfile.get(profile.id)?.has(gid));
      if (saved.length === 1) {
        const productGid = saved[0]!;
        matched.push({ profile, productGid, title: titles.get(productGid), manual: true });
      } else {
        heldBack.push({ sku: profile.sku, reason: `${candidates.size} products share this SKU prefix, so the match is ambiguous` });
      }
    } else {
      const productGid = [...candidates][0]!;
      matched.push({ profile, productGid, title: titles.get(productGid) });
    }
  }

  const overridePlan = await planOverrides(prisma, storeId, matched);
  const blocked = overridePlan.filter((e) => e.action === "blocked");
  const blockedGids = new Set(blocked.map((e) => e.productGid));
  const writable = matched.filter((m) => !blockedGids.has(m.productGid));

  const existing = await fetchExistingPolicies(admin, writable.map((m) => m.productGid));
  const shopPolicy = await fetchShopPolicyState(admin);
  const policyJsonByGid = new Map(writable.map((m) => [m.productGid, plannedPolicyJson(m, existing.get(m.productGid), shopPolicy)]));
  const plan = planPolicyWrites(writable, existing, (m) => policyJsonByGid.get(m.productGid)!);
  const overridesPresent = overridePlan.filter((e) => e.action === "unchanged" || e.legacyGidRow || e.fromProfileId !== undefined).length;
  return { matched, heldBack, overridesPresent, overridePlan, blocked, shopPolicy, policyJsonByGid, policyBeforeByGid: existing, ...plan };
}

function enforcedPolicy(raw: unknown): boolean {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return false; }
  }
  const parsed = parseProductPricingPolicy(value);
  return parsed?.active === true && parsed.required === true;
}

/** Defense in depth: an enabled pilot may repair an already-enforced product, never add one. */
export function unsafeActivationExpansions(report: LinkReport): LinkCandidate[] {
  if (!report.shopPolicy.enabled) return [];
  return report.toWrite.filter((m) => {
    const desired = report.policyJsonByGid.get(m.productGid);
    return enforcedPolicy(desired) && !enforcedPolicy(report.policyBeforeByGid.get(m.productGid));
  });
}

export async function applyLinkReport(
  prisma: PrismaClient,
  admin: AdminGraphqlClientLike,
  storeId: string,
  report: LinkReport,
): Promise<{ written: number; errors: string[]; overridesCreated: number; overridesUpdated: number; coverage: BestEffortReconcile }> {
  const unsafe = unsafeActivationExpansions(report);
  if (unsafe.length) {
    throw new Error(`refusing to activate ${unsafe.length} product policy/policies while shop enforcement is enabled`);
  }
  let written = 0;
  const errors: string[] = [];
  for (let i = 0; i < report.toWrite.length; i += METAFIELD_BATCH) {
    const batch = report.toWrite.slice(i, i + METAFIELD_BATCH);
    const data = await gql(admin, POLICY_WRITE, {
      metafields: batch.map((m) => ({
        ownerId: m.productGid,
        namespace: "$app:imprintid",
        key: "pricing_policy",
        type: "json",
        value: report.policyJsonByGid.get(m.productGid)!,
      })),
    });
    const result = data.metafieldsSet as { metafields: unknown[]; userErrors: { message: string }[] };
    written += result.metafields.length;
    errors.push(...result.userErrors.map((e) => e.message));
  }

  // Local link, keyed by the BARE numeric product id. Unchanged and blocked products are not
  // touched; a legacy GID-keyed row is left exactly as it is.
  let overridesCreated = 0;
  let overridesUpdated = 0;
  for (const entry of report.overridePlan) {
    if (entry.action !== "create" && entry.action !== "update") continue;
    await prisma.productPricingOverride.upsert({
      where: { storeId_shopifyProductId: { storeId, shopifyProductId: entry.bareKey } },
      update: { pricingProfileId: entry.profileId, isActive: true },
      create: { storeId, shopifyProductId: entry.bareKey, pricingProfileId: entry.profileId, isActive: true },
    });
    if (entry.action === "create") overridesCreated += 1;
    else overridesUpdated += 1;
  }

  // Keep the Catalog page's coverage columns in step with the overrides just written. Scoped to
  // exactly these products and best-effort: it never fails the link.
  const coverage = await reconcileCoverageForProducts(
    prisma,
    storeId,
    report.overridePlan.filter((e) => e.action === "create" || e.action === "update").map((e) => e.productGid),
  );
  return { written, errors, overridesCreated, overridesUpdated, coverage };
}

// ---------------------------------------------------------------------------------------
// Preview summary (pure; no I/O)
// ---------------------------------------------------------------------------------------

/** A plain, serialisable description of exactly what applyLinkReport would do. */
export function summarizeLinkReport(report: LinkReport) {
  const idOf = (gid: string) => gid.split("/").pop() ?? gid;
  const policyStatus = new Map(report.problems.map((p) => [p.productGid, p.status]));
  return {
    totals: {
      matched: report.matched.length,
      heldBack: report.heldBack.length,
      blocked: report.blocked.length,
      shopifyPolicyWrites: report.toWrite.length,
      policyAlreadyCorrect: report.counts.ok,
      overridesToCreate: report.overridePlan.filter((e) => e.action === "create").length,
      overridesToUpdate: report.overridePlan.filter((e) => e.action === "update").length,
      overridesUnchanged: report.overridePlan.filter((e) => e.action === "unchanged").length,
      legacyGidRowsLeftUntouched: report.overridePlan.filter((e) => e.legacyGidRow).length,
    },
    matched: report.matched.map((m) => ({
      sku: m.profile.sku,
      productId: idOf(m.productGid),
      title: m.title ?? null,
      manualResolution: m.manual === true,
    })),
    heldBack: report.heldBack,
    blocked: report.blocked.map((b) => ({ sku: b.sku, productId: idOf(b.productGid), reason: b.reason })),
    proposedShopifyWrites: report.toWrite.map((m) => ({
      sku: m.profile.sku,
      productId: idOf(m.productGid),
      reason: policyStatus.get(m.productGid) ?? "missing",
    })),
    proposedOverrideChanges: report.overridePlan
      .filter((e) => e.action === "create" || e.action === "update")
      .map((e) => ({
        sku: e.sku,
        key: e.bareKey,
        action: e.action,
        profileId: e.profileId,
        replacesProfileId: e.fromProfileId ?? null,
        legacyGidRowPresent: e.legacyGidRow === true,
      })),
    overridesUnchanged: report.overridePlan.filter((e) => e.action === "unchanged").map((e) => ({ sku: e.sku, key: e.bareKey })),
  };
}
