import {
  PricingError,
  PricingProfileInactive,
  PricingProfileNotFound,
  StoreNotFound,
} from "../pricing/index.ts";
import type { PricingCalculationResult } from "../pricing/index.ts";
import type { ApiErrorBody, ApiIssue, ApiSuccessBody } from "./types.ts";

/**
 * The product/tenant itself can't be found or isn't usable — the client's request
 * shape is fine, but there is nothing to price.
 */
const NOT_FOUND_ERRORS = [StoreNotFound, PricingProfileNotFound, PricingProfileInactive];

/**
 * Maps a thrown value from `calculatePrice` to an HTTP status. Every other
 * `PricingError` subclass (invalid quantity, unknown option, missing decoration rule,
 * etc.) is a 422 — the request was shaped correctly but the pricing selection itself
 * doesn't resolve to a valid price. Anything that isn't a `PricingError` at all is
 * unexpected and maps to 500 — see `toErrorBody`, which also makes sure such errors
 * never leak their raw message to the client.
 */
export function mapPricingErrorToStatus(error: unknown): number {
  if (error instanceof PricingError) {
    if (NOT_FOUND_ERRORS.some((ErrorClass) => error instanceof ErrorClass)) {
      return 404;
    }
    return 422;
  }
  return 500;
}

export function toErrorBody(error: unknown): ApiErrorBody {
  if (error instanceof PricingError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  // Never forward a raw Prisma error, stack trace, or other internal detail.
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred while calculating pricing." },
  };
}

export function invalidRequestBody(issues: ApiIssue[]): ApiErrorBody {
  return {
    ok: false,
    error: { code: "INVALID_REQUEST_BODY", message: "The request body is invalid.", issues },
  };
}

export function malformedJson(): ApiErrorBody {
  return { ok: false, error: { code: "MALFORMED_JSON", message: "Request body must be valid JSON." } };
}

export function methodNotAllowed(): ApiErrorBody {
  return { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "This endpoint only accepts POST." } };
}

export function toSuccessBody(data: PricingCalculationResult): ApiSuccessBody {
  return { ok: true, data };
}
