/**
 * Task 6A — canonical Shopify Product GID handling. Every product identifier that
 * enters the catalog subsystem passes through `parseProductGid` first; a value that is
 * not exactly `gid://shopify/Product/<positive-decimal>` is rejected, never coerced.
 */

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/([1-9]\d*)$/;
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/([1-9]\d*)$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;

/** Returns the canonical GID string for a valid product identifier, or `null`.
 * Accepts a canonical GID or a bare positive-decimal numeric id (Shopify bulk-query
 * `__parentId` values and webhook `id` fields are sometimes bare). Never a JS number —
 * Shopify ids exceed `Number.MAX_SAFE_INTEGER`. */
export function parseProductGid(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    // A bare number is tolerated only up to the safe-integer boundary; beyond that the
    // string form must be used (Shopify never sends unsafe numbers in these fields).
    return Number.isSafeInteger(value) ? `gid://shopify/Product/${value}` : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (PRODUCT_GID.test(trimmed)) return trimmed;
  if (POSITIVE_DECIMAL.test(trimmed)) return `gid://shopify/Product/${trimmed}`;
  return null;
}

export function parseVariantGid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (VARIANT_GID.test(trimmed)) return trimmed;
  if (POSITIVE_DECIMAL.test(trimmed)) return `gid://shopify/ProductVariant/${trimmed}`;
  return null;
}

/** The trailing numeric id of a product GID (`gid://shopify/Product/123` → `"123"`). */
export function productGidNumericId(gid: string): string | null {
  const m = PRODUCT_GID.exec(gid);
  return m ? m[1]! : null;
}

/**
 * The key format `ProductPricingOverride.shopifyProductId` uses.
 *
 * IMPORTANT: the storefront pricing resolver (`pricing/repository.ts#loadPricingContext`,
 * `pricing-api/product-resolver.ts#overrideAppliesToProduct`) and the provisioner both
 * key `ProductPricingOverride` by the BARE numeric product id — that is the shape
 * `parseShopifyNumericId` produces from a cart line's product-id property. The catalog
 * subsystem works in canonical GIDs everywhere else, so every place it reads or writes
 * `ProductPricingOverride` must convert through here, or a bulk-assigned override becomes
 * invisible to the enforcement-critical storefront path (and a legacy bare-keyed override
 * gets silently duplicated).
 *
 * Accepts a canonical GID or an already-bare numeric id; returns the bare numeric id, or
 * `null` if neither.
 */
export function overrideProductKey(productIdOrGid: string): string | null {
  const gid = parseProductGid(productIdOrGid);
  return gid ? productGidNumericId(gid) : null;
}

/** Validates + de-duplicates a list of product identifiers into canonical GIDs.
 * `{ gids, invalid }` — `invalid` holds the raw values that failed, for a clear error. */
export function normalizeProductGidList(values: readonly unknown[]): { gids: string[]; invalid: unknown[] } {
  const seen = new Set<string>();
  const invalid: unknown[] = [];
  for (const v of values) {
    const gid = parseProductGid(v);
    if (gid === null) {
      invalid.push(v);
      continue;
    }
    seen.add(gid);
  }
  return { gids: [...seen], invalid };
}
