import type { PrismaClient } from "@prisma/client";
import type { ApiErrorBody } from "./types.ts";

/**
 * Task 4A — the SINGLE centralized storefront product/variant resolver shared by both
 * the catalog (GET) and pricing (POST) App Proxy handlers, so their rules can never
 * drift. It runs AFTER `authenticate.public.appProxy` has already verified Shopify's
 * HMAC signature and resolved the trusted `shopDomain` — this module never trusts
 * `shop`, product id, variant id, or SKU merely because the browser supplied them:
 *
 *   1. validate `shopifyProductId` / `shopifyVariantId` as bare positive decimal
 *      strings (never converted to a JS number — Shopify ids exceed 2^53);
 *   2. resolve the local `Store` from the authenticated shop domain;
 *   3. GID-ify the validated ids and confirm, through the caller's authenticated Admin
 *      GraphQL client, that the variant exists, that its parent product id matches
 *      `shopifyProductId`, and that it is `availableForSale`;
 *   4. look up a `ProductPricingOverride` scoped to (this Store, this product id) — an
 *      active override pointing at an active profile is authoritative and needs no SKU;
 *   5. only if there is no valid override, fall back to the SKU lookup, and only when
 *      the SKU is a non-blank string;
 *   6. a blank SKU with no valid product override is a controlled "pricing not
 *      configured" response — never the default/first profile.
 *
 * Returns the validated identity + the resolution source, or a controlled,
 * non-sensitive `{ status, body }` error. It NEVER returns an access token, secret,
 * signed payload, DB connection detail, raw Shopify GraphQL body, or stack trace.
 */

const POSITIVE_DECIMAL_ID = /^[1-9][0-9]*$/;

/**
 * Accepts ONLY a bare positive decimal digit string (`"1"`, `"9442404663548"`).
 * Rejects: missing/undefined/null, blank/whitespace, `"0"`, leading-zero, negative,
 * decimal, scientific-notation, `gid://…`-shaped, objects, arrays, booleans, JS
 * numbers, and any mixed-character value. Returns the ORIGINAL string with no numeric
 * conversion — Shopify ids can exceed `Number.MAX_SAFE_INTEGER` and must stay decimal
 * strings end to end.
 */
export function parseShopifyNumericId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!POSITIVE_DECIMAL_ID.test(value)) return null;
  return value;
}

/** Builds a Shopify Product GID from an ALREADY-VALIDATED decimal id string. Never
 * call with an unvalidated value — validate with `parseShopifyNumericId` first. */
export function toProductGid(numericId: string): string {
  return `gid://shopify/Product/${numericId}`;
}

/** Builds a Shopify ProductVariant GID from an ALREADY-VALIDATED decimal id string. */
export function toVariantGid(numericId: string): string {
  return `gid://shopify/ProductVariant/${numericId}`;
}

const GID_TAIL = /\/([1-9][0-9]*)$/;

/** Extracts the trailing decimal id from a Shopify GID string returned by the Admin
 * API (`gid://shopify/Product/123` → `"123"`). Returns `null` for anything that isn't
 * that exact shape — never a numeric conversion. */
export function numericIdFromGid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = GID_TAIL.exec(value);
  return match ? match[1]! : null;
}

/** Minimal shape of the authenticated Admin GraphQL client (`admin.graphql`) this
 * resolver needs — real one from `authenticate.public.appProxy`, or a mock in tests.
 * Deliberately narrow so tests never have to construct a full Shopify client. */
export interface AdminGraphqlClientLike {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

export interface ResolveStorefrontProductDeps {
  prisma: PrismaClient;
  /** The authenticated Admin GraphQL client, or `null` when no offline session /
   * Admin context is available — in which case blank-SKU resolution fails closed. */
  admin: AdminGraphqlClientLike | null;
  /** The trusted shop domain from the verified App Proxy session — NEVER from the body. */
  shopDomain: string;
}

export interface StorefrontProductRequest {
  shopifyProductId: unknown;
  shopifyVariantId: unknown;
  /** Optional supporting metadata only — a blank/absent SKU never independently
   * authorizes pricing. */
  sku?: unknown;
}

export type ResolvedStorefrontProduct =
  | {
      ok: true;
      shopDomain: string;
      storeId: string;
      shopifyProductId: string;
      shopifyVariantId: string;
      /** `""` when a product override is authoritative and no SKU is needed. */
      sku: string;
      resolutionSource: "product_override" | "sku";
    }
  | {
      ok: false;
      status: number;
      body: ApiErrorBody;
    };

function err(status: number, code: string, message: string): ResolvedStorefrontProduct {
  return { ok: false, status, body: { ok: false, error: { code, message } } };
}

/** Non-secret, storefront-safe error strings — one per failure mode in §8 of the task. */
const ERRORS = {
  INVALID_PRODUCT_CONTEXT: "A valid Shopify product id and variant id are both required.",
  INVALID_PRODUCT_ID: "The product identifier is not valid.",
  INVALID_VARIANT_ID: "The selected variant identifier is not valid.",
  INVALID_SKU: "The SKU value is not valid.",
  SHOP_NOT_AVAILABLE: "Pricing is not available for this shop.",
  ADMIN_SESSION_UNAVAILABLE: "Pricing cannot be verified for this shop right now.",
  VARIANT_NOT_FOUND: "The selected variant could not be found.",
  PRODUCT_VARIANT_MISMATCH: "The selected variant does not belong to this product.",
  VARIANT_UNAVAILABLE: "The selected variant is not available for sale.",
  PRICING_CONFIGURATION_INVALID: "Pricing for this product is not configured correctly.",
  PRICING_NOT_CONFIGURED: "Pricing is not configured for this product.",
} as const;

/**
 * Task 4A.1 §1 — the PUBLIC App Proxy route (catalog GET + pricing POST) requires BOTH
 * a Shopify product id and variant id on every request. This is the single gate the
 * route calls before anything else. It rejects — with one controlled
 * `400 INVALID_PRODUCT_CONTEXT` — when both are absent, only one is present, or either
 * is blank or malformed. The route never falls back to a SKU-only path and never
 * bypasses the Admin verification in `resolveStorefrontProductContext` below.
 *
 * (SKU-only resolution still exists for `/api/pricing` and internal handlers via
 * `handlePricingApiRequest` / `loadPricingContext` — just not through this public
 * storefront route.)
 */
export function requireStorefrontProductContext(
  rawProductId: unknown,
  rawVariantId: unknown,
):
  | { ok: true; shopifyProductId: string; shopifyVariantId: string }
  | { ok: false; status: number; body: ApiErrorBody } {
  const shopifyProductId = parseShopifyNumericId(rawProductId);
  const shopifyVariantId = parseShopifyNumericId(rawVariantId);
  if (!shopifyProductId || !shopifyVariantId) {
    return { ok: false, status: 400, body: { ok: false, error: { code: "INVALID_PRODUCT_CONTEXT", message: ERRORS.INVALID_PRODUCT_CONTEXT } } };
  }
  return { ok: true, shopifyProductId, shopifyVariantId };
}

const VARIANT_VERIFY_QUERY = `#graphql
  query ImprintIdResolveVariant($id: ID!) {
    productVariant(id: $id) {
      id
      availableForSale
      product { id }
    }
  }`;

interface VariantVerifyResult {
  id: string;
  availableForSale: boolean;
  productId: string;
}

/**
 * Confirms the requested variant through the authenticated Admin GraphQL client. Only
 * a fully-consistent, available variant returns a value; every other outcome (client
 * unavailable, thrown request, no variant, id/product mismatch, unavailable, malformed
 * response) returns a controlled error. The raw GraphQL body is never surfaced.
 */
async function verifyVariantViaAdmin(
  admin: AdminGraphqlClientLike | null,
  productId: string,
  variantId: string,
): Promise<{ ok: true; variant: VariantVerifyResult } | { ok: false; error: ResolvedStorefrontProduct }> {
  if (!admin) {
    return { ok: false, error: err(403, "ADMIN_SESSION_UNAVAILABLE", ERRORS.ADMIN_SESSION_UNAVAILABLE) };
  }

  let payload: unknown;
  try {
    const response = await admin.graphql(VARIANT_VERIFY_QUERY, { variables: { id: toVariantGid(variantId) } });
    payload = await response.json();
  } catch (error) {
    console.error("[pricing-api] admin variant verification request failed:", error);
    return { ok: false, error: err(403, "ADMIN_SESSION_UNAVAILABLE", ERRORS.ADMIN_SESSION_UNAVAILABLE) };
  }

  const node =
    payload && typeof payload === "object"
      ? (payload as { data?: { productVariant?: unknown } }).data?.productVariant
      : undefined;

  if (!node || typeof node !== "object") {
    return { ok: false, error: err(404, "VARIANT_NOT_FOUND", ERRORS.VARIANT_NOT_FOUND) };
  }

  const record = node as { id?: unknown; availableForSale?: unknown; product?: unknown };
  const returnedVariantId = numericIdFromGid(record.id);
  const returnedProductId =
    record.product && typeof record.product === "object"
      ? numericIdFromGid((record.product as { id?: unknown }).id)
      : null;

  if (returnedVariantId !== variantId) {
    return { ok: false, error: err(422, "PRODUCT_VARIANT_MISMATCH", ERRORS.PRODUCT_VARIANT_MISMATCH) };
  }
  if (!returnedProductId || returnedProductId !== productId) {
    return { ok: false, error: err(422, "PRODUCT_VARIANT_MISMATCH", ERRORS.PRODUCT_VARIANT_MISMATCH) };
  }
  if (record.availableForSale !== true) {
    return { ok: false, error: err(422, "VARIANT_UNAVAILABLE", ERRORS.VARIANT_UNAVAILABLE) };
  }

  return {
    ok: true,
    variant: { id: returnedVariantId, productId: returnedProductId, availableForSale: true },
  };
}

/**
 * Whether an active `ProductPricingOverride` for (storeId, shopifyProductId) that
 * points at an active pricing profile of the SAME store exists. Store-scoped by the
 * compound unique key — an override belonging to another store's id can never match,
 * and there is no global-by-product-id fallback.
 *
 *  - active override → active same-store profile      → `"authoritative"`
 *  - active override → inactive/missing/other-store profile → `"invalid"` (fail closed)
 *  - inactive override                                 → `"invalid"` (fail closed)
 *  - no override row at all                            → `"none"` (SKU fallback allowed)
 */
async function classifyProductOverride(
  prisma: PrismaClient,
  storeId: string,
  shopifyProductId: string,
): Promise<"authoritative" | "invalid" | "none"> {
  const bareId = numericIdFromGid(shopifyProductId) ?? shopifyProductId;
  const gid = toProductGid(bareId);
  const override = await prisma.productPricingOverride.findFirst({
    where: {
      storeId,
      shopifyProductId: { in: [bareId, gid] },
    },
  });
  if (!override) return "none";
  if (!override.isActive) return "invalid";
  if (!override.pricingProfileId) return "invalid";

  const profile = await prisma.pricingProfile.findUnique({
    where: { id: override.pricingProfileId },
    select: { storeId: true, isActive: true },
  });
  if (!profile || profile.storeId !== storeId || !profile.isActive) return "invalid";
  return "authoritative";
}

export async function resolveStorefrontProductContext(
  deps: ResolveStorefrontProductDeps,
  request: StorefrontProductRequest,
): Promise<ResolvedStorefrontProduct> {
  const { prisma, admin, shopDomain } = deps;

  const shopifyProductId = parseShopifyNumericId(request.shopifyProductId);
  if (!shopifyProductId) return err(400, "INVALID_PRODUCT_ID", ERRORS.INVALID_PRODUCT_ID);

  const shopifyVariantId = parseShopifyNumericId(request.shopifyVariantId);
  if (!shopifyVariantId) return err(400, "INVALID_VARIANT_ID", ERRORS.INVALID_VARIANT_ID);

  // SKU is optional supporting metadata. `undefined`/`null` normalize to `""` at this
  // request boundary. But an EXPLICIT number / boolean / object / array is a malformed
  // request — Task 4A.1 §2: reject it (`400 INVALID_SKU`), never silently coerce it to
  // `""`, even when a valid product override would otherwise make the SKU irrelevant.
  if (request.sku !== undefined && request.sku !== null && typeof request.sku !== "string") {
    return err(400, "INVALID_SKU", ERRORS.INVALID_SKU);
  }
  const sku = typeof request.sku === "string" ? request.sku : "";

  const store = await prisma.store.findUnique({ where: { shopDomain } });
  if (!store) return err(404, "SHOP_NOT_AVAILABLE", ERRORS.SHOP_NOT_AVAILABLE);

  const verification = await verifyVariantViaAdmin(admin, shopifyProductId, shopifyVariantId);
  if (!verification.ok) return verification.error;

  const overrideClass = await classifyProductOverride(prisma, store.id, shopifyProductId);

  if (overrideClass === "authoritative") {
    return {
      ok: true,
      shopDomain,
      storeId: store.id,
      shopifyProductId,
      shopifyVariantId,
      sku: "", // an authoritative product override needs no SKU
      resolutionSource: "product_override",
    };
  }

  if (overrideClass === "invalid") {
    return err(422, "PRICING_CONFIGURATION_INVALID", ERRORS.PRICING_CONFIGURATION_INVALID);
  }

  // overrideClass === "none": SKU fallback, but only for a genuine, non-blank SKU.
  if (sku.trim().length === 0) {
    return err(404, "PRICING_NOT_CONFIGURED", ERRORS.PRICING_NOT_CONFIGURED);
  }

  return {
    ok: true,
    shopDomain,
    storeId: store.id,
    shopifyProductId,
    shopifyVariantId,
    sku,
    resolutionSource: "sku",
  };
}
