import { DecorationMethod } from "@prisma/client";
import type {
  CalculationInput,
  DecorationSelectionInput,
  OptionSelectionInput,
} from "../pricing/index.ts";
import type { ApiIssue } from "./types.ts";

const VALID_DECORATION_METHODS = new Set<string>(Object.values(DecorationMethod));

export type PricingRequestInput = Omit<CalculationInput, "shopDomain">;

export type ParsePricingRequestResult =
  | { ok: true; input: PricingRequestInput }
  | { ok: false; issues: ApiIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * API-boundary validation only: is the request shaped like a `CalculationInput`
 * (right fields, right JS types)? This deliberately does NOT check business rules —
 * "quantity must be positive," "this option value belongs to this group," "this
 * decoration code exists for this profile," etc. all remain the pricing engine's
 * responsibility (`calculatePrice` throws a typed `PricingError` for those — see
 * response.ts for how those map to HTTP status codes). Duplicating those checks here
 * would mean two sources of truth for the same rule.
 */
export function parsePricingRequestBody(raw: unknown): ParsePricingRequestResult {
  const issues: ApiIssue[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: "(body)", message: "Request body must be a JSON object" }] };
  }

  // Task 4A: a blank SKU is allowed ONLY when a shopifyProductId is present — the
  // storefront-side resolver (product-resolver.ts) has already validated that id and
  // confirmed an authoritative ProductPricingOverride before this point, so a
  // blank-SKU calculation resolves entirely via the product-id override path. A blank
  // SKU with no shopifyProductId is still rejected (nothing to price against).
  const hasProductId = typeof raw.shopifyProductId === "string" && raw.shopifyProductId.trim().length > 0;
  if (typeof raw.sku !== "string") {
    issues.push({ path: "sku", message: "sku must be a string" });
  } else if (raw.sku.trim().length === 0 && !hasProductId) {
    issues.push({ path: "sku", message: "sku is required unless a shopifyProductId is provided" });
  }

  if (typeof raw.quantity !== "number") {
    issues.push({ path: "quantity", message: "quantity is required and must be a number" });
  }

  if (raw.shopifyProductId !== undefined && raw.shopifyProductId !== null && typeof raw.shopifyProductId !== "string") {
    issues.push({ path: "shopifyProductId", message: "shopifyProductId must be a string when provided" });
  }

  let productColor: CalculationInput["productColor"];
  if (raw.productColor !== undefined) {
    if (!isPlainObject(raw.productColor)) {
      issues.push({ path: "productColor", message: 'productColor must be an object, e.g. { "code": "BLACK" }' });
    } else if (typeof raw.productColor.code !== "string" || raw.productColor.code.trim().length === 0) {
      issues.push({ path: "productColor.code", message: "productColor.code is required and must be a non-empty string" });
    } else {
      productColor = { code: raw.productColor.code };
    }
  }

  let decoration: DecorationSelectionInput | undefined;
  if (raw.decoration !== undefined) {
    if (!isPlainObject(raw.decoration)) {
      issues.push({ path: "decoration", message: "decoration must be an object" });
    } else {
      const d = raw.decoration;
      if (typeof d.method !== "string" || !VALID_DECORATION_METHODS.has(d.method)) {
        issues.push({
          path: "decoration.method",
          message: `decoration.method is required and must be one of: ${[...VALID_DECORATION_METHODS].join(", ")}`,
        });
      }
      if (typeof d.colors !== "number") {
        issues.push({ path: "decoration.colors", message: "decoration.colors is required and must be a number" });
      }
      if (typeof d.locations !== "number") {
        issues.push({ path: "decoration.locations", message: "decoration.locations is required and must be a number" });
      }
      if (typeof d.reverseSide !== "boolean") {
        issues.push({ path: "decoration.reverseSide", message: "decoration.reverseSide is required and must be a boolean" });
      }
      if (typeof d.differentReverseArtwork !== "boolean") {
        issues.push({
          path: "decoration.differentReverseArtwork",
          message: "decoration.differentReverseArtwork is required and must be a boolean",
        });
      }
      if (typeof d.repeatOrder !== "boolean") {
        issues.push({ path: "decoration.repeatOrder", message: "decoration.repeatOrder is required and must be a boolean" });
      }
      if (
        typeof d.method === "string" &&
        VALID_DECORATION_METHODS.has(d.method) &&
        typeof d.colors === "number" &&
        typeof d.locations === "number" &&
        typeof d.reverseSide === "boolean" &&
        typeof d.differentReverseArtwork === "boolean" &&
        typeof d.repeatOrder === "boolean"
      ) {
        decoration = {
          method: d.method as DecorationMethod,
          colors: d.colors,
          locations: d.locations,
          reverseSide: d.reverseSide,
          differentReverseArtwork: d.differentReverseArtwork,
          repeatOrder: d.repeatOrder,
        };
      }
    }
  }

  let options: OptionSelectionInput[] | undefined;
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) {
      issues.push({ path: "options", message: "options must be an array" });
    } else {
      const parsedOptions: OptionSelectionInput[] = [];
      raw.options.forEach((entry, index) => {
        const path = `options[${index}]`;
        if (!isPlainObject(entry)) {
          issues.push({ path, message: "each option selection must be an object" });
          return;
        }
        const groupNameOk = typeof entry.groupName === "string" && entry.groupName.trim().length > 0;
        const optionValueIdOk = typeof entry.optionValueId === "string" && entry.optionValueId.trim().length > 0;
        if (!groupNameOk) {
          issues.push({ path: `${path}.groupName`, message: "groupName is required and must be a non-empty string" });
        }
        if (!optionValueIdOk) {
          issues.push({ path: `${path}.optionValueId`, message: "optionValueId is required and must be a non-empty string" });
        }
        if (groupNameOk && optionValueIdOk) {
          parsedOptions.push({
            groupName: entry.groupName as string,
            optionValueId: entry.optionValueId as string,
          });
        }
      });
      options = parsedOptions;
    }
  }

  let production: CalculationInput["production"];
  if (raw.production !== undefined) {
    if (!isPlainObject(raw.production)) {
      issues.push({
        path: "production",
        message: 'production must be an object, e.g. { "code": "RUSH" } — not a bare string',
      });
    } else if (raw.production.code !== undefined && typeof raw.production.code !== "string") {
      issues.push({ path: "production.code", message: "production.code must be a string when provided" });
    } else {
      production = { code: raw.production.code as string | undefined };
    }
  }

  let packaging: CalculationInput["packaging"];
  if (raw.packaging !== undefined) {
    if (!isPlainObject(raw.packaging)) {
      issues.push({ path: "packaging", message: 'packaging must be an object, e.g. { "code": "STANDARD_CARTON" }' });
    } else if (raw.packaging.code !== undefined && typeof raw.packaging.code !== "string") {
      issues.push({ path: "packaging.code", message: "packaging.code must be a string when provided" });
    } else {
      packaging = { code: raw.packaging.code as string | undefined };
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    input: {
      sku: raw.sku as string,
      quantity: raw.quantity as number,
      shopifyProductId: (raw.shopifyProductId as string | null | undefined) ?? undefined,
      productColor,
      decoration,
      options,
      production,
      packaging,
    },
  };
}
