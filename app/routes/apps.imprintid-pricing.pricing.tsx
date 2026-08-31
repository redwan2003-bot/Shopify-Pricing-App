import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { handleStorefrontPricingRequest } from "../lib/pricing-api/storefront-handler.ts";
import { malformedJson, methodNotAllowed, mapPricingErrorToStatus, toErrorBody } from "../lib/pricing-api/response.ts";
import { loadPricingCatalog } from "../lib/pricing-api/catalog.ts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /apps/imprintid-pricing/pricing?sku=LNY01 — the read-only counterpart to the
 * POST calculation below: returns what the customer *can* select (quantity tiers,
 * option groups/values, production rules), never a priced result. See
 * app/lib/pricing-api/catalog.ts for why this exists and why it isn't a second
 * pricing engine. Same App Proxy authentication as the POST handler.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return jsonResponse(
      { ok: false, error: { code: "SHOP_NOT_AVAILABLE", message: "Pricing is not available for this shop." } },
      404,
    );
  }

  const sku = new URL(request.url).searchParams.get("sku");
  if (!sku) {
    return jsonResponse(
      { ok: false, error: { code: "INVALID_REQUEST_BODY", message: "A sku query parameter is required." } },
      400,
    );
  }

  try {
    const catalog = await loadPricingCatalog(prisma, session.shop, sku);
    return jsonResponse({ ok: true, data: catalog }, 200);
  } catch (error) {
    console.error("[pricing-api] catalog lookup failed:", error);
    return jsonResponse(toErrorBody(error), mapPricingErrorToStatus(error));
  }
};

/**
 * POST /apps/imprintid-pricing/pricing — the App Proxy-facing counterpart to
 * `/api/pricing` (Phase 2.4), reachable by anonymous storefront visitors. Contains
 * no pricing calculation of its own — see `docs/storefront-pricing-bridge.md` for the
 * full contract and `app/lib/pricing-api/storefront-handler.ts` for everything past
 * authentication and JSON parsing.
 *
 * Shopify only ever routes requests here that arrived at
 * `https://{shop}.myshopify.com/apps/imprintid-pricing/pricing` — see the `[app_proxy]`
 * block in shopify.app.toml. `authenticate.public.appProxy` verifies Shopify's HMAC
 * signature on the query string (added by Shopify's proxy layer, not the storefront
 * visitor) before this route's own code runs, and resolves the calling shop from
 * Shopify's own session storage via that verified signature — never from anything the
 * storefront visitor supplied. This route does not introduce a new auth mechanism; it
 * reuses the same `authenticate` object as every other route in this app.
 * `/api/pricing` itself is untouched by this phase.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return jsonResponse(methodNotAllowed(), 405);
  }

  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "SHOP_NOT_AVAILABLE",
          message: "Pricing is not available for this shop.",
        },
      },
      404,
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse(malformedJson(), 400);
  }

  const result = await handleStorefrontPricingRequest(prisma, session.shop, rawBody);
  return jsonResponse(result.body, result.status);
};
