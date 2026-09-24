import type { PrismaClient } from "@prisma/client";
import type { AdminGraphqlClientLike } from "../pricing-api/product-resolver.ts";
import { buildProductPolicyValue, canonicalPolicyJson, normalizeExistingPolicyJson } from "../catalog/policy-value.ts";

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
 */

export const POLICY_REVISION = 1;
const METAFIELD_BATCH = 25;
const NODES_BATCH = 100;

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

// ---------------------------------------------------------------------------------------

const SKU_INDEX_QUERY = `#graphql
  query ImprintIdSkuIndex($cursor: String) {
    products(first: 100, after: $cursor) {
      edges { cursor node { id title variants(first: 100) { edges { node { sku } } } } }
      pageInfo { hasNextPage }
    }
  }`;

const POLICY_READ_QUERY = `#graphql
  query ImprintIdPolicyRead($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id metafield(namespace: "$app:imprintid", key: "pricing_policy") { value } }
    }
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
  let cursor: string | null = null;
  for (;;) {
    const data = await gql(admin, SKU_INDEX_QUERY, { cursor });
    const products = data.products as {
      edges: { cursor: string; node: { id: string; title: string; variants: { edges: { node: { sku: string | null } }[] } } }[];
      pageInfo: { hasNextPage: boolean };
    };
    for (const { node } of products.edges) {
      titles.set(node.id, node.title);
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
  return { index, titles };
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

export interface LinkReport {
  matched: LinkCandidate[];
  heldBack: { sku: string | null; reason: string }[];
  counts: Record<PolicyStatus, number>;
  toWrite: LinkCandidate[];
  problems: { sku: string | null; productGid: string; status: PolicyStatus }[];
  overridesPresent: number;
}

export async function buildLinkReport(prisma: PrismaClient, admin: AdminGraphqlClientLike, storeId: string): Promise<LinkReport> {
  const { index, titles } = await fetchSkuIndex(admin);
  const profiles = await prisma.pricingProfile.findMany({ where: { storeId }, select: { id: true, sku: true, revision: true } });

  const matched: LinkCandidate[] = [];
  const heldBack: LinkReport["heldBack"] = [];
  for (const profile of profiles) {
    const candidates = index.get((profile.sku ?? "").toUpperCase());
    if (!candidates || candidates.size === 0) {
      heldBack.push({ sku: profile.sku, reason: "no product in the store has variant SKUs starting with this SKU" });
    } else if (candidates.size > 1) {
      heldBack.push({ sku: profile.sku, reason: `${candidates.size} products share this SKU prefix, so the match is ambiguous` });
    } else {
      const productGid = [...candidates][0]!;
      matched.push({ profile, productGid, title: titles.get(productGid) });
    }
  }

  const existing = await fetchExistingPolicies(admin, matched.map((m) => m.productGid));
  const plan = planPolicyWrites(matched, existing, expectedPolicyJson);
  const overridesPresent = await prisma.productPricingOverride.count({
    where: { storeId, isActive: true, shopifyProductId: { in: matched.map((m) => m.productGid) } },
  });
  return { matched, heldBack, overridesPresent, ...plan };
}

export async function applyLinkReport(
  prisma: PrismaClient,
  admin: AdminGraphqlClientLike,
  storeId: string,
  report: LinkReport,
): Promise<{ written: number; errors: string[] }> {
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
        value: expectedPolicyJson(m),
      })),
    });
    const result = data.metafieldsSet as { metafields: unknown[]; userErrors: { message: string }[] };
    written += result.metafields.length;
    errors.push(...result.userErrors.map((e) => e.message));
  }
  // Local link for every matched product, so a freshly seeded database gets its overrides too.
  for (const m of report.matched) {
    await prisma.productPricingOverride.upsert({
      where: { storeId_shopifyProductId: { storeId, shopifyProductId: m.productGid } },
      update: { pricingProfileId: m.profile.id, isActive: true },
      create: { storeId, shopifyProductId: m.productGid, pricingProfileId: m.profile.id, isActive: true },
    });
  }
  return { written, errors };
}
