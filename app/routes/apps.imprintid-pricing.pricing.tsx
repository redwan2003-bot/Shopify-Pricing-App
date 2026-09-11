import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { handleStorefrontPricingRequest, canIssueSignedV2Quote } from "../lib/pricing-api/storefront-handler.ts";
import { malformedJson, methodNotAllowed, mapPricingErrorToStatus, toErrorBody } from "../lib/pricing-api/response.ts";
import { loadPricingCatalog } from "../lib/pricing-api/catalog.ts";
import {
  createDefaultCartPricingPolicyProvider,
  cartPricingEnforcementUiState,
} from "../lib/pricing-api/cart-pricing-policy-provider.ts";
import {
  requireStorefrontProductContext,
  resolveStorefrontProductContext,
  parseShopifyNumericId,
  type AdminGraphqlClientLike,
} from "../lib/pricing-api/product-resolver.ts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SHOP_UNAVAILABLE = {
  ok: false as const,
  error: { code: "SHOP_NOT_AVAILABLE", message: "Pricing is not available for this shop." },
};

/**
 * The PUBLIC App Proxy pricing route. Task 4A.1 §1: BOTH handlers below require a valid
 * Shopify product id + variant id on every request (`requireStorefrontProductContext`)
 * and always run the authenticated resolver (`resolveStorefrontProductContext`) —
 * validate the ids, verify the variant against the Admin GraphQL client (exists,
 * belongs to the product, available for sale), and resolve an active store-scoped
 * ProductPricingOverride — before any pricing profile is loaded. There is NO SKU-only
 * bypass on this route (SKU-only resolution still exists on `/api/pricing` and internal
 * handlers). `authenticate.public.appProxy` has already verified Shopify's HMAC and
 * resolved the trusted `shopDomain` — nothing here trusts the browser's `shop`/ids/SKU.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return jsonResponse({ ...SHOP_UNAVAILABLE }, 404);

  const params = new URL(request.url).searchParams;

  // Task 5B.3B §Phase-1.2 — POLICY BOOTSTRAP. A minimal, authenticated (App Proxy
  // HMAC-verified) product-policy lookup for a storefront block that failed closed on
  // variant metadata and therefore can never reach the catalog/pricing path to learn
  // an authoritative `bypass`. Uses ONLY the verified shop context + the emitted Shopify
  // product id — no variant id, no SKU, no variant map, no pricing calculation, no
  // Admin variant verification. Reuses the same `createDefaultCartPricingPolicyProvider`.
  if (params.get("policyOnly") === "1") {
    const policyProductId = parseShopifyNumericId(params.get("shopifyProductId"));
    if (!policyProductId) {
      return jsonResponse({ ok: false, error: { code: "INVALID_PRODUCT_ID", message: "The product identifier is not valid." } }, 400);
    }
    let state: "enforce" | "bypass" | "block" = "block";
    try {
      const decision = await createDefaultCartPricingPolicyProvider({
        prisma,
        admin: (admin as AdminGraphqlClientLike | undefined) ?? null,
      }).resolve({ shopDomain: session.shop, shopifyProductId: policyProductId });
      state = cartPricingEnforcementUiState(decision, canIssueSignedV2Quote());
    } catch (policyError) {
      console.error("[pricing-api] policy-only lookup failed:", policyError);
    }
    return jsonResponse({ ok: true, data: { enforcement: { state } } }, 200);
  }

  const ctx = requireStorefrontProductContext(params.get("shopifyProductId"), params.get("shopifyVariantId"));
  if (!ctx.ok) return jsonResponse(ctx.body, ctx.status);

  const resolved = await resolveStorefrontProductContext(
    { prisma, admin: (admin as AdminGraphqlClientLike | undefined) ?? null, shopDomain: session.shop },
    { shopifyProductId: ctx.shopifyProductId, shopifyVariantId: ctx.shopifyVariantId, sku: params.get("sku") ?? undefined },
  );
  if (!resolved.ok) return jsonResponse(resolved.body, resolved.status);

  try {
    const catalog = await loadPricingCatalog(prisma, session.shop, {
      sku: resolved.sku,
      shopifyProductId: resolved.shopifyProductId,
      shopifyVariantId: resolved.shopifyVariantId,
    });

    // Task 5B.3A.1 — carry the three-state enforcement decision on the catalog response
    // too, so the storefront gets an accurate `bypass` / `block` / `enforce` state on
    // first load (not only after the first pricing POST). Fails closed to `block`.
    let enforcement: { state: "enforce" | "bypass" | "block" } = { state: "block" };
    try {
      const decision = await createDefaultCartPricingPolicyProvider({
        prisma,
        admin: (admin as AdminGraphqlClientLike | undefined) ?? null,
      }).resolve({ shopDomain: session.shop, shopifyProductId: resolved.shopifyProductId });
      enforcement = { state: cartPricingEnforcementUiState(decision, canIssueSignedV2Quote()) };
    } catch (policyError) {
      console.error("[pricing-api] enforcement policy resolution failed:", policyError);
    }

    return jsonResponse({ ok: true, data: { ...catalog, enforcement } }, 200);
  } catch (error) {
    console.error("[pricing-api] catalog lookup failed:", error);
    return jsonResponse(toErrorBody(error), mapPricingErrorToStatus(error));
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return jsonResponse(methodNotAllowed(), 405);
  }

  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return jsonResponse({ ...SHOP_UNAVAILABLE }, 404);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse(malformedJson(), 400);
  }

  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};

  const ctx = requireStorefrontProductContext(body.shopifyProductId, body.shopifyVariantId);
  if (!ctx.ok) return jsonResponse(ctx.body, ctx.status);

  const resolved = await resolveStorefrontProductContext(
    { prisma, admin: (admin as AdminGraphqlClientLike | undefined) ?? null, shopDomain: session.shop },
    { shopifyProductId: ctx.shopifyProductId, shopifyVariantId: ctx.shopifyVariantId, sku: body.sku },
  );
  if (!resolved.ok) return jsonResponse(resolved.body, resolved.status);

  const result = await handleStorefrontPricingRequest(
    prisma,
    session.shop,
    { ...body, sku: resolved.sku, shopifyProductId: resolved.shopifyProductId },
    { shopifyProductId: resolved.shopifyProductId, shopifyVariantId: resolved.shopifyVariantId },
    // Task 5B.3A: the authenticated Admin client lets the v2 policy provider read the
    // app-owned enforcement-policy metafields. `null` ⇒ the provider fails closed.
    { admin: (admin as AdminGraphqlClientLike | undefined) ?? null },
  );
  return jsonResponse(result.body, result.status);
};
