/**
 * Task 6A.3A — the catalog subsystem's bridge to `ProductPricingOverride`.
 *
 * `ProductPricingOverride.shopifyProductId` is keyed by the BARE numeric product id
 * (`"9442404663548"`), because that is the shape the enforcement-critical storefront
 * path uses (`pricing/repository.ts#loadPricingContext`,
 * `pricing-api/product-resolver.ts#overrideAppliesToProduct`, and the provisioner). The
 * rest of the catalog subsystem works in canonical GIDs. Every override read/write from
 * the catalog subsystem MUST go through here so a bulk-assigned override is visible to
 * the storefront and a legacy bare-keyed override is never silently duplicated.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { overrideProductKey } from "./gid.ts";

export type OverrideClient = Pick<PrismaClient, "productPricingOverride">;

export interface OverrideRow {
  shopifyProductId: string; // bare numeric id, as stored
  pricingProfileId: string | null;
  isActive: boolean;
  basePriceCents: number | null;
}

/** `{ storeId_shopifyProductId: { storeId, shopifyProductId: <bare> } }` for a single
 * override write, given a canonical GID (or a bare id). Throws on a malformed id. */
export function overrideWhereUnique(storeId: string, productGid: string): Prisma.ProductPricingOverrideWhereUniqueInput {
  const key = overrideProductKey(productGid);
  if (!key) throw new Error(`cannot derive a ProductPricingOverride key from "${productGid}"`);
  return { storeId_shopifyProductId: { storeId, shopifyProductId: key } };
}

/** The bare `shopifyProductId` value for a `create` payload. */
export function overrideKeyValue(productGid: string): string {
  const key = overrideProductKey(productGid);
  if (!key) throw new Error(`cannot derive a ProductPricingOverride key from "${productGid}"`);
  return key;
}

/**
 * Loads the overrides for a batch of canonical product GIDs and returns them in a map
 * KEYED BY GID (so callers keep working in GIDs). Internally queries by the bare numeric
 * keys.
 */
export async function loadOverridesByGid(
  client: OverrideClient,
  storeId: string,
  productGids: readonly string[],
  select: Prisma.ProductPricingOverrideSelect = { shopifyProductId: true, pricingProfileId: true, isActive: true, basePriceCents: true },
): Promise<Map<string, OverrideRow>> {
  const keyToGid = new Map<string, string>();
  for (const gid of productGids) {
    const k = overrideProductKey(gid);
    if (k) keyToGid.set(k, gid);
  }
  if (keyToGid.size === 0) return new Map();

  const rows = (await client.productPricingOverride.findMany({
    where: { storeId, shopifyProductId: { in: [...keyToGid.keys()] } },
    select,
  })) as OverrideRow[];

  const byGid = new Map<string, OverrideRow>();
  for (const row of rows) {
    const gid = keyToGid.get(row.shopifyProductId);
    if (gid) byGid.set(gid, row);
  }
  return byGid;
}
