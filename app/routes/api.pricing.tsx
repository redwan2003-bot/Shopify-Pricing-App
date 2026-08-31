import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { handlePricingApiRequest } from "../lib/pricing-api/handler.ts";
import { malformedJson, methodNotAllowed } from "../lib/pricing-api/response.ts";
import type { ApiResponseBody } from "../lib/pricing-api/types.ts";

function jsonResponse(body: ApiResponseBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/pricing — thin adapter around the Phase 2.3 calculation engine
 * (`calculatePrice`, in `app/lib/pricing`). Contains no pricing calculation itself —
 * see `docs/pricing-api.md` for the full request/response contract and
 * `app/lib/pricing-api/handler.ts` for everything past authentication and JSON
 * parsing.
 *
 * Tenant resolution: the calling shop is taken from the authenticated Shopify admin
 * session (`session.shop`), never from the request body. `authenticate.admin` is the
 * same session infrastructure every other authenticated route in this app already
 * uses — this route does not introduce a second auth mechanism, and does not attempt
 * to handle the not-yet-configured App Proxy / public storefront case (see
 * docs/pricing-api.md "App Proxy considerations").
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return jsonResponse(methodNotAllowed(), 405);
  }

  const { session } = await authenticate.admin(request);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse(malformedJson(), 400);
  }

  const result = await handlePricingApiRequest(prisma, session.shop, rawBody);
  return jsonResponse(result.body, result.status);
};
