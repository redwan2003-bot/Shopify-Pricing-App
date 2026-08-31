import type { PricingCatalog } from "../pricing-api/catalog.ts";
import type { ProductConfigurationState } from "./types.ts";

/**
 * Builds the initial configuration state for a freshly-loaded catalog. Pure and
 * synchronous — no calculation happens here, only a reasonable starting selection:
 *
 * - quantity: the lowest configured tier's minimum (falls back to 1 if the profile has
 *   no quantity tiers at all — the server-side calculation will report that error
 *   itself; this function never invents a tier).
 * - decorationMethod: the profile's first available method, if any.
 * - productionCode: the profile's single non-rush rule, mirroring the same default the
 *   calculation engine itself applies when no production selection is given (see
 *   `app/lib/pricing/calculator.ts#resolveProduction`) — left `null` (forcing an
 *   explicit choice) when that default would be ambiguous.
 * - every optional dimension (color, options) starts unselected: this module never
 *   guesses a "default" selection the catalog didn't actually mark as one.
 */
export function buildDefaultConfigurationState(catalog: PricingCatalog): ProductConfigurationState {
  const lowestTier = [...catalog.quantityTiers].sort((a, b) => a.minQuantity - b.minQuantity)[0];
  const nonRushProductionRules = catalog.productionRules.filter((rule) => !rule.isRush);

  return {
    quantity: lowestTier?.minQuantity ?? 1,
    decorationMethod: catalog.decorationMethods[0] ?? null,
    colors: 1,
    locations: 1,
    reverseSide: false,
    differentReverseArtwork: false,
    repeatOrder: false,
    productColorCode: null,
    selectedOptionValueIds: {},
    productionCode: nonRushProductionRules.length === 1 ? nonRushProductionRules[0]!.code : null,
  };
}

/**
 * The request body this route's action expects (POSTed as JSON). Shaped to match
 * `CalculationInput` minus `shopDomain` (the action sources that from the authenticated
 * admin session, never from the client — same rule `app/lib/pricing-api/request.ts`
 * already enforces for the storefront route). A dimension the customer hasn't
 * configured yet is omitted entirely (not sent as `null`/`undefined`) — a plain JSON
 * object, not a partially-`undefined` one, both because `fetcher.submit`'s JSON
 * encoding requires it and so the server's own validation, not this function, decides
 * whether an incomplete configuration is still calculable.
 */
export interface CalculationRequestBody {
  sku: string;
  quantity: number;
  productColor?: { code: string };
  decoration?: {
    method: string;
    colors: number;
    locations: number;
    reverseSide: boolean;
    differentReverseArtwork: boolean;
    repeatOrder: boolean;
  };
  options?: Array<{ groupName: string; optionValueId: string }>;
  production?: { code: string };
}

export function buildCalculationRequestBody(sku: string, state: ProductConfigurationState): CalculationRequestBody {
  const options = Object.entries(state.selectedOptionValueIds).map(([groupName, optionValueId]) => ({
    groupName,
    optionValueId,
  }));

  return {
    sku,
    quantity: state.quantity,
    ...(state.productColorCode ? { productColor: { code: state.productColorCode } } : {}),
    ...(state.decorationMethod
      ? {
          decoration: {
            method: state.decorationMethod,
            colors: state.colors,
            locations: state.locations,
            reverseSide: state.reverseSide,
            differentReverseArtwork: state.reverseSide && state.differentReverseArtwork,
            repeatOrder: state.repeatOrder,
          },
        }
      : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(state.productionCode ? { production: { code: state.productionCode } } : {}),
  };
}

/** Attachment-kind option groups, in catalog order — see `OptionGroupKind` (Phase 2.7). */
export function selectAttachmentGroups(catalog: PricingCatalog) {
  return catalog.optionGroups.filter((group) => group.kind === "ATTACHMENT");
}

/** Feature-kind option groups (e.g. "Optional Features"). */
export function selectFeatureGroups(catalog: PricingCatalog) {
  return catalog.optionGroups.filter((group) => group.kind === "FEATURE");
}

/** Anything not classified as Attachment or Feature — rendered generically so no
 * configured option group is ever silently dropped from the UI. */
export function selectGenericGroups(catalog: PricingCatalog) {
  return catalog.optionGroups.filter((group) => group.kind !== "ATTACHMENT" && group.kind !== "FEATURE");
}

const DECORATION_METHOD_LABELS: Record<string, string> = {
  SCREEN_PRINT: "Screen Print",
  EMBROIDERY: "Embroidery",
  DTF: "DTF",
  DTG: "DTG",
  VINYL: "Vinyl",
  SUBLIMATION: "Sublimation",
  OTHER: "Other",
};

/** Human-readable snapshot of the current configuration for the Request-a-Quote
 * placeholder (STEP 14) — display only, built from the same state the calculation
 * request body is built from. */
export function buildQuoteSummary(
  catalog: PricingCatalog,
  state: ProductConfigurationState,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Quantity", value: state.quantity.toLocaleString("en-US") },
  ];

  if (state.decorationMethod) {
    rows.push({
      label: "Decoration Method",
      value: DECORATION_METHOD_LABELS[state.decorationMethod] ?? state.decorationMethod,
    });
    rows.push({ label: "Colors", value: String(state.colors) });
    rows.push({ label: "Locations", value: String(state.locations) });
    if (state.reverseSide) {
      rows.push({
        label: "Reverse Side",
        value: state.differentReverseArtwork ? "Yes, different artwork" : "Yes, same artwork",
      });
    }
    if (state.repeatOrder) rows.push({ label: "Repeat Order", value: "Yes" });
  }

  if (state.productColorCode) {
    const color = catalog.productColors.find((c) => c.code === state.productColorCode);
    rows.push({ label: "Product Color", value: color?.name ?? state.productColorCode });
  }

  for (const [groupName, optionValueId] of Object.entries(state.selectedOptionValueIds)) {
    const group = catalog.optionGroups.find((g) => g.name === groupName);
    const value = group?.values.find((v) => v.id === optionValueId);
    if (value) rows.push({ label: groupName, value: value.label });
  }

  if (state.productionCode) {
    const rule = catalog.productionRules.find((r) => r.code === state.productionCode);
    rows.push({ label: "Production", value: rule?.name ?? state.productionCode });
  }

  return rows;
}
