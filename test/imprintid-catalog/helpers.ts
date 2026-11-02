/**
 * Task 6A — shared synthetic fixtures for the catalog-management test suite.
 *
 * Every test runs against the isolated Neon test branch (`TEST_DATABASE_URL`) using
 * disposable `*.myshopify.com` shop domains that are deleted in `after`. NO real shop,
 * product, token or signing secret is ever used.
 */

import { createTestPrisma } from "../support/prisma.ts";
import { randomUUID } from "node:crypto";
import type { CatalogWritePort, PolicyRead, PolicySetRequest, PolicyWriteOutcome } from "../../app/lib/catalog/write-port.ts";
import { normalizeExistingPolicyJson } from "../../app/lib/catalog/policy-value.ts";
import { overrideProductKey } from "../../app/lib/catalog/gid.ts";

export const prisma = createTestPrisma();

/**
 * A second line of defence: retry a genuinely transient lock error a few times with
 * backoff. Used by the seed helpers below; the code under test uses its own (production)
 * retry policy.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, label = "db op"): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!/socket timeout|SQLITE_BUSY|database is locked|failed to respond/i.test(msg)) throw error;
      lastErr = error;
      await new Promise((r) => setTimeout(r, attempt * 250 + Math.random() * 200));
    }
  }
  throw new Error(`${label} still failing after retries: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

let shopCounter = 0;
export function makeShopDomain(prefix: string): string {
  shopCounter += 1;
  return `${prefix}-${process.pid}-${shopCounter}.myshopify.com`;
}

export async function seedStore(shopDomain: string, shopCurrency: string | null = "USD"): Promise<string> {
  const store = await withDbRetry(() => prisma.store.upsert({
    where: { shopDomain },
    update: { shopCurrency },
    create: { shopDomain, shopCurrency },
  }), "seedStore");
  return store.id;
}

export async function cleanupShops(shopDomains: string[]): Promise<void> {
  if (shopDomains.length === 0) return;
  const stores = await withDbRetry(
    () => prisma.store.findMany({ where: { shopDomain: { in: shopDomains } }, select: { id: true } }),
    "cleanup lookup",
  );
  const storeId = { in: stores.map((s) => s.id) };
  // Bulk-delete children explicitly (one `DELETE ... WHERE storeId IN (...)` each) — far
  // faster than Prisma's row-by-row emulated cascade on SQLite for large catalogs.
  for (const del of [
    () => prisma.bulkAssignmentAudit.deleteMany({ where: { storeId } }),
    () => prisma.bulkAssignmentItem.deleteMany({ where: { storeId } }),
    () => prisma.bulkAssignmentJob.deleteMany({ where: { storeId } }),
    () => prisma.catalogSyncJob.deleteMany({ where: { storeId } }),
    () => prisma.webhookEvent.deleteMany({ where: { storeId } }),
    () => prisma.catalogVariant.deleteMany({ where: { storeId } }),
    () => prisma.catalogProduct.deleteMany({ where: { storeId } }),
    () => prisma.productPricingOverride.deleteMany({ where: { storeId } }),
    () => prisma.pricingProfile.deleteMany({ where: { storeId } }),
    () => prisma.store.deleteMany({ where: { id: storeId } }),
  ]) {
    await withDbRetry(del, "cleanup delete");
  }
}

export interface SeedProfileOpts {
  name?: string;
  currency?: string;
  isActive?: boolean;
  revision?: number;
  sku?: string | null;
}

export async function seedProfile(storeId: string, opts: SeedProfileOpts = {}): Promise<{ id: string; revision: number; currency: string }> {
  const p = await withDbRetry(() => prisma.pricingProfile.create({
    data: {
      storeId,
      name: opts.name ?? `Profile ${randomUUID().slice(0, 8)}`,
      sku: opts.sku ?? null,
      currency: opts.currency ?? "USD",
      isActive: opts.isActive ?? true,
      revision: opts.revision ?? 1,
    },
  }), "seedProfile");
  return { id: p.id, revision: p.revision, currency: p.currency };
}

export interface SeedCatalogProductOpts {
  gid?: string;
  title?: string;
  handle?: string;
  status?: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string;
  hasAnySku?: boolean;
  coverageStatus?: string;
  assignedProfileId?: string | null;
  policySyncedAt?: Date | null;
  removedFromShopifyAt?: Date | null;
  shopifyUpdatedAt?: Date | null;
}

let productCounter = 1_000_000;
export async function seedCatalogProduct(storeId: string, opts: SeedCatalogProductOpts = {}): Promise<{ id: string; shopifyProductId: string }> {
  productCounter += 1;
  const gid = opts.gid ?? `gid://shopify/Product/${productCounter}`;
  const row = await withDbRetry(() => prisma.catalogProduct.create({
    data: {
      storeId,
      shopifyProductId: gid,
      title: opts.title ?? `Product ${productCounter}`,
      handle: opts.handle ?? `product-${productCounter}`,
      status: opts.status ?? "ACTIVE",
      vendor: opts.vendor ?? null,
      productType: opts.productType ?? null,
      tags: opts.tags ?? "",
      hasAnySku: opts.hasAnySku ?? false,
      coverageStatus: opts.coverageStatus ?? "unassigned",
      assignedProfileId: opts.assignedProfileId ?? null,
      policySyncedAt: opts.policySyncedAt ?? null,
      removedFromShopifyAt: opts.removedFromShopifyAt ?? null,
      shopifyUpdatedAt: opts.shopifyUpdatedAt ?? new Date("2026-01-01T00:00:00Z"),
    },
  }), "seedCatalogProduct");
  return { id: row.id, shopifyProductId: row.shopifyProductId };
}

/** Bulk-seeds N catalog products in one `createMany` — for large-scale perf tests. */
export async function seedManyCatalogProducts(storeId: string, n: number, opts: { skuEvery?: number } = {}): Promise<string[]> {
  const base = productCounter + 1;
  productCounter += n;
  const skuEvery = opts.skuEvery ?? 2;
  const data = Array.from({ length: n }, (_, i) => ({
    storeId,
    shopifyProductId: `gid://shopify/Product/${base + i}`,
    title: `Bulk ${base + i}`,
    handle: `bulk-${base + i}`,
    status: "ACTIVE",
    tags: "",
    hasAnySku: i % skuEvery === 0,
    coverageStatus: "unassigned",
    shopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
  }));
  // SQLite bind-variable limit → chunk the createMany.
  for (let i = 0; i < data.length; i += 1000) {
    await withDbRetry(() => prisma.catalogProduct.createMany({ data: data.slice(i, i + 1000) }), "seedManyCatalogProducts");
  }
  return data.map((d) => d.shopifyProductId);
}

/**
 * Seeds a `ProductPricingOverride`. Accepts a canonical GID or a bare numeric id and
 * stores it BARE-KEYED — the format the storefront pricing resolver and (as of Task
 * 6A.3A) the catalog subsystem both use.
 */
export async function seedOverride(
  storeId: string,
  shopifyProductIdOrGid: string,
  pricingProfileId: string | null,
  opts: { isActive?: boolean; basePriceCents?: number | null } = {},
): Promise<void> {
  const key = overrideProductKey(shopifyProductIdOrGid) ?? shopifyProductIdOrGid;
  await withDbRetry(() => prisma.productPricingOverride.upsert({
    where: { storeId_shopifyProductId: { storeId, shopifyProductId: key } },
    update: { pricingProfileId, isActive: opts.isActive ?? true, basePriceCents: opts.basePriceCents ?? null },
    create: { storeId, shopifyProductId: key, pricingProfileId, isActive: opts.isActive ?? true, basePriceCents: opts.basePriceCents ?? null },
  }), "seedOverride");
}

/** The bare-numeric override key for a product GID — for tests that query
 * `ProductPricingOverride` directly. */
export function overrideKeyFor(shopifyProductIdOrGid: string): string {
  return overrideProductKey(shopifyProductIdOrGid) ?? shopifyProductIdOrGid;
}

// ---------------------------------------------------------------------------
// Synthetic Shopify surfaces
// ---------------------------------------------------------------------------

let variantCounter = 5_000_000;

/** Seeds variants for an existing catalog product. */
export async function seedCatalogVariants(
  storeId: string,
  product: { id: string; shopifyProductId: string },
  variants: Array<{ sku?: string | null; title?: string }>,
): Promise<string[]> {
  const data = variants.map((v, i) => {
    variantCounter += 1;
    return {
      storeId,
      catalogProductId: product.id,
      shopifyVariantId: `gid://shopify/ProductVariant/${variantCounter}`,
      shopifyProductId: product.shopifyProductId,
      title: v.title ?? `Variant ${i + 1}`,
      sku: v.sku ?? null,
      position: i,
    };
  });
  for (let i = 0; i < data.length; i += 500) {
    await prisma.catalogVariant.createMany({ data: data.slice(i, i + 500) });
  }
  await prisma.catalogProduct.update({
    where: { id: product.id },
    data: { variantCount: data.length, hasAnySku: data.some((d) => d.sku !== null) },
  });
  return data.map((d) => d.shopifyVariantId);
}

/** Builds a flattened bulk-query JSONL string: one product line, then its variant lines. */
export function buildCatalogJsonl(
  products: Array<{ id: string; title?: string; handle?: string; status?: string; vendor?: string; productType?: string; tags?: string[]; updatedAt?: string; variants?: Array<{ id: string; sku?: string }> }>,
): string {
  const lines: string[] = [];
  for (const p of products) {
    lines.push(
      JSON.stringify({
        id: p.id,
        title: p.title ?? "T",
        handle: p.handle ?? "h",
        status: p.status ?? "ACTIVE",
        vendor: p.vendor ?? null,
        productType: p.productType ?? null,
        tags: p.tags ?? [],
        updatedAt: p.updatedAt ?? "2026-01-01T00:00:00Z",
        variantsCount: { count: (p.variants ?? []).length },
      }),
    );
    for (const v of p.variants ?? []) {
      lines.push(JSON.stringify({ id: v.id, sku: v.sku ?? "", __parentId: p.id }));
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * An in-memory, compare-and-set `CatalogWritePort` that simulates Shopify's semantics:
 * every stored value has a digest, a write must present the digest of the value it
 * expects, or literal `null` (NEVER `""`) to assert absence, and a mismatch is reported
 * as a conflict rather than an overwrite. Records every call so tests can assert
 * round-trip counts. Throws on a `""` compareDigest (regression guard).
 */
export class FakeWritePort implements CatalogWritePort {
  private store = new Map<string, { json: string; digest: string; metafieldId: string }>();
  readonly calls: Array<{ op: string; gid: string; count?: number }> = [];
  /** productGid -> queued failure outcomes for setProductPolicies (shift per call) */
  failSet = new Map<string, PolicyWriteOutcome[]>();
  /** productGids whose read should throw */
  failRead = new Set<string>();
  private seq = 0;

  /** Seeds a value as if some other actor had written it. */
  seedExisting(gid: string, json: string): string {
    const digest = this.nextDigest(gid);
    this.store.set(gid, { json: normalizeExistingPolicyJson(safeParse(json)), digest, metafieldId: `gid://shopify/Metafield/${gid.split("/").pop()}` });
    return digest;
  }
  current(gid: string): string {
    return this.store.get(gid)?.json ?? "";
  }
  currentDigest(gid: string): string | null {
    return this.store.get(gid)?.digest ?? null;
  }
  /** Simulates a third party changing the value out from under us. */
  externalWrite(gid: string, json: string): string {
    return this.seedExisting(gid, json);
  }

  private nextDigest(gid: string): string {
    this.seq += 1;
    return `dg_${gid.split("/").pop()}_${this.seq}`;
  }

  async readProductPolicies(productGids: string[]): Promise<Map<string, PolicyRead>> {
    this.calls.push({ op: "read", gid: productGids[0] ?? "", count: productGids.length });
    const out = new Map<string, PolicyRead>();
    for (const gid of productGids) {
      if (this.failRead.has(gid)) throw new Error(`simulated read failure for ${gid}`);
      const row = this.store.get(gid);
      out.set(gid, {
        productGid: gid,
        present: !!row,
        metafieldId: row?.metafieldId ?? null,
        jsonValue: row ? safeParse(row.json) : null,
        compareDigest: row?.digest ?? null,
      });
    }
    return out;
  }

  /** the exact compareDigest each product was sent on the most recent setProductPolicies */
  readonly lastCompareDigests = new Map<string, string | null>();

  async setProductPolicies(requests: PolicySetRequest[]): Promise<Map<string, PolicyWriteOutcome>> {
    this.calls.push({ op: "set", gid: requests[0]?.productGid ?? "", count: requests.length });
    const out = new Map<string, PolicyWriteOutcome>();
    this.lastCompareDigests.clear();
    for (const r of requests) {
      // Regression guard — the write port must never hand us "" (or a non-string,
      // non-null value). Task 6A.1.1.
      if ((r.compareDigest as unknown) === "") {
        throw new Error(`FakeWritePort: compareDigest "" for ${r.productGid} — use null to assert absence`);
      }
      if (r.compareDigest !== null && typeof r.compareDigest !== "string") {
        throw new Error(`FakeWritePort: compareDigest of type ${typeof r.compareDigest} for ${r.productGid}`);
      }
      this.lastCompareDigests.set(r.productGid, r.compareDigest);

      const queued = this.failSet.get(r.productGid);
      if (queued && queued.length) {
        const outcome = queued.shift()!;
        if (!outcome.ok) {
          out.set(r.productGid, outcome);
          continue;
        }
      }
      const row = this.store.get(r.productGid);
      // Absent metafield → expected compare token is `null`; present → its digest.
      const expected: string | null = row ? row.digest : null;
      if (r.compareDigest !== expected) {
        out.set(r.productGid, {
          ok: false,
          conflict: true,
          code: "CONFLICT_DIGEST_MISMATCH",
          message:
            expected === null
              ? "the product has no pricing policy but a digest was supplied"
              : r.compareDigest === null
                ? "the product's pricing policy exists but absence was asserted"
                : "the product's pricing policy changed since it was read — not overwritten",
        });
        continue;
      }
      const digest = this.nextDigest(r.productGid);
      this.store.set(r.productGid, {
        json: normalizeExistingPolicyJson(safeParse(r.valueJson)),
        digest,
        metafieldId: row?.metafieldId ?? `gid://shopify/Metafield/${r.productGid.split("/").pop()}`,
      });
      out.set(r.productGid, { ok: true, compareDigest: digest });
    }
    return out;
  }

  async deleteProductPolicy(productGid: string, expectedDigest: string | null): Promise<PolicyWriteOutcome> {
    this.calls.push({ op: "delete", gid: productGid });
    const row = this.store.get(productGid);
    if (!row) return { ok: true, compareDigest: null };
    if (expectedDigest === null || row.digest !== expectedDigest) {
      return {
        ok: false,
        conflict: true,
        code: "CONFLICT_DIGEST_MISMATCH",
        message: "the product's pricing policy changed since this job wrote it — not deleted",
      };
    }
    this.store.delete(productGid);
    return { ok: true, compareDigest: null };
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const ENFORCEMENT_DISABLED = {
  schema: 1,
  mode: "disabled",
  enabled: false,
  adjustmentVariantGid: "gid://shopify/ProductVariant/1",
  installBinding: "test-binding",
  policyRevision: 1,
};

export const ENFORCEMENT_ENABLED = { ...ENFORCEMENT_DISABLED, mode: "universal", enabled: true };
