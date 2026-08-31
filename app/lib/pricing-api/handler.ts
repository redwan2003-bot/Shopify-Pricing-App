import type { PrismaClient } from "@prisma/client";
import { calculatePrice } from "../pricing/index.ts";
import { parsePricingRequestBody } from "./request.ts";
import { invalidRequestBody, mapPricingErrorToStatus, toErrorBody, toSuccessBody } from "./response.ts";
import type { ApiResult } from "./types.ts";

/**
 * The pricing API's core logic, with the Shopify-authentication and raw-HTTP layers
 * already stripped away — see `app/routes/api.pricing.tsx`, which is the thin wrapper
 * that resolves `shopDomain` from the authenticated session and calls this.
 *
 * `shopDomain` is a parameter, never read from `rawBody` — the caller (the route) is
 * responsible for sourcing it from the authenticated Shopify session, never from the
 * client-supplied request body. This function doesn't know how to get a shop domain
 * any other way, which is deliberate: there is no code path here that would let a
 * request body override the tenant.
 *
 * Contains no pricing calculation of its own — everything price-related is delegated
 * to `calculatePrice` (Phase 2.3). This function only: validates the request shape,
 * calls the engine, and maps the result/error to an HTTP status + JSON body.
 */
export async function handlePricingApiRequest(
  prisma: PrismaClient,
  shopDomain: string,
  rawBody: unknown,
): Promise<ApiResult> {
  const parsed = parsePricingRequestBody(rawBody);
  if (!parsed.ok) {
    return { status: 400, body: invalidRequestBody(parsed.issues) };
  }

  try {
    const result = await calculatePrice(prisma, { ...parsed.input, shopDomain });
    return { status: 200, body: toSuccessBody(result) };
  } catch (error) {
    console.error("[pricing-api] calculation failed:", error);
    return { status: mapPricingErrorToStatus(error), body: toErrorBody(error) };
  }
}
