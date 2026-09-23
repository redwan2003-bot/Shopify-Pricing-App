import type { PricingCalculationResult } from "../pricing/index.ts";
import type { PricingCatalog } from "../pricing-api/catalog.ts";
import type { ProductConfigurationState } from "./types.ts";
import { formatCents } from "./format.ts";

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

/**
 * A stable, canonical string that changes IFF a real pricing-calculation input changes
 * (sku, quantity, decoration, options, production, product color). Two configuration
 * states that would produce the same price produce the same fingerprint — regardless of
 * object identity, `selectedOptionValueIds` key insertion order, or any unrelated
 * rerender. `app/routes/app.product-configuration` submits exactly one calculation per
 * distinct fingerprint (see `shouldSubmitCalculation`), which is what breaks the
 * "recalculate forever" loop: the recalculation effect keys on this string, never on
 * loader data / fetcher identity / freshly-created objects.
 */
export function buildCalculationFingerprint(sku: string, state: ProductConfigurationState): string {
  const body = buildCalculationRequestBody(sku, state);
  const options = (body.options ?? [])
    .slice()
    .sort((a, b) => (a.groupName < b.groupName ? -1 : a.groupName > b.groupName ? 1 : 0))
    .map((o) => `${o.groupName}=${o.optionValueId}`)
    .join("&");
  return JSON.stringify({
    sku: body.sku,
    quantity: body.quantity,
    productColor: body.productColor?.code ?? null,
    decoration: body.decoration
      ? [
          body.decoration.method,
          body.decoration.colors,
          body.decoration.locations,
          body.decoration.reverseSide,
          body.decoration.differentReverseArtwork,
          body.decoration.repeatOrder,
        ].join(",")
      : null,
    options,
    production: body.production?.code ?? null,
  });
}

/**
 * The single decision the recalculation effect makes: submit a new calculation only
 * when the configuration is ready AND its fingerprint differs from the one already
 * submitted (tracked in a ref, set at submit time). This dedupes: the initial load,
 * a response arriving, an identical rerender, an in-flight request, and an error
 * response all leave the fingerprint unchanged ⇒ no (re)submission. Only a genuine
 * input change flips it.
 */
export function shouldSubmitCalculation(args: {
  ready: boolean;
  fingerprint: string;
  lastSubmittedFingerprint: string | null;
}): boolean {
  if (!args.ready) return false;
  if (args.fingerprint.length === 0) return false;
  return args.fingerprint !== args.lastSubmittedFingerprint;
}

/**
 * `shouldRevalidate` for `app/routes/app.product-configuration`. A pricing recalculation
 * is a `POST` (fetcher submission) to this route's own action; it never changes the
 * catalog / product / SKU the loader returns. Revalidating the loader on every POST
 * re-fetches Shopify Admin on every keystroke AND mints a fresh `catalog` object that
 * used to retrigger the recalculation effect — an infinite loop, and the source of the
 * intermittent `shop: null` revalidation requests. So: never revalidate on POST; defer
 * to React Router's default for real navigations (e.g. the `?sku=` param changing).
 */
export function productConfigurationShouldRevalidate(
  formMethod: string | undefined,
  defaultShouldRevalidate: boolean,
): boolean {
  if (typeof formMethod === "string" && formMethod.toUpperCase() === "POST") return false;
  return defaultShouldRevalidate;
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

/**
 * The rate-column label for a *list* unit price — `List Price (6R)` when the catalog
 * assigns the quantity tier a `priceCode`, or plain `List Price` when it does not (LNY01
 * carries no price codes). The code itself is authoritative catalog data; this helper
 * only formats it and never fabricates one. Shared by the quantity-tier list and the
 * Price Summary's Quantity row so the two surfaces cannot word it differently.
 */
export function formatListRateLabel(priceCode: string | null): string {
  return priceCode ? `List Price (${priceCode})` : "List Price";
}

/** One line in the "Selected Configuration" view — a human-readable label/value pair
 * plus a stable key for React and for deterministic ordering. `value` is always a
 * catalog label, never a database id or code, and is shown even when it is `No` /
 * `None` / included / `$0`. */
export interface SelectedConfigurationRow {
  key: string;
  label: string;
  value: string;
}

/**
 * The single, shared, typed view model for "everything the merchant has currently
 * configured" — rendered by the Price Summary's *Selected Configuration* section and by
 * the Request-a-Quote snapshot (`buildQuoteSummary`), so the two never reconstruct
 * labels independently. Pure and synchronous: it does no pricing arithmetic, never
 * recomputes a tier price, and has no bearing on the calculation fingerprint or the
 * recalculation loop — callers memoize it purely for display.
 *
 * Rules it enforces:
 * - Every value is a human-readable catalog label, never an internal id/code.
 * - A dimension that *is* selected is always shown, even when its value is `No` /
 *   `None` / included / `$0`; only genuinely unselected optional groups are omitted
 *   (never the unpicked alternatives of a group that is selected).
 * - Option groups are walked in catalog order — ordering is deterministic and any
 *   option/packaging group a future catalog adds shows up automatically. Nothing here
 *   is keyed to LNY01's specific groups.
 * - When a priced `result` is supplied the Quantity row also carries the
 *   server-resolved unit price and its rate label (from `result`, verbatim); without
 *   one it shows the quantity alone rather than inventing a price.
 */
export function buildSelectedConfigurationRows(
  catalog: PricingCatalog,
  state: ProductConfigurationState,
  result?: PricingCalculationResult | null,
): SelectedConfigurationRow[] {
  const rows: SelectedConfigurationRow[] = [];

  const quantity = result ? result.quantity : state.quantity;
  const quantityText = quantity.toLocaleString("en-US");
  if (result) {
    const unitPrice = formatCents(result.base.listUnitPriceCents);
    const rateLabel = formatListRateLabel(result.quantityTier.priceCode);
    rows.push({
      key: "quantity",
      label: "Quantity",
      value: unitPrice ? `${quantityText} · ${rateLabel} ${unitPrice}` : `${quantityText} · ${rateLabel}`,
    });
  } else {
    rows.push({ key: "quantity", label: "Quantity", value: quantityText });
  }

  if (state.productColorCode) {
    const color = catalog.productColors.find((c) => c.code === state.productColorCode);
    rows.push({ key: "product-color", label: "Product Color", value: color?.name ?? state.productColorCode });
  }

  if (state.decorationMethod) {
    rows.push({
      key: "decoration-method",
      label: "Decoration Method",
      value: DECORATION_METHOD_LABELS[state.decorationMethod] ?? state.decorationMethod,
    });
    rows.push({
      key: "decoration-colors",
      label: "Decoration Colors",
      value: state.colors === 1 ? "1 Color" : "2+ Colors",
    });
    rows.push({
      key: "imprint-location",
      label: "Imprint Location",
      value: state.locations === 1 ? "Front Only" : "Front + Back",
    });
    rows.push({ key: "reverse-side", label: "Reverse Side", value: state.reverseSide ? "Yes" : "No" });
    if (state.reverseSide) {
      rows.push({
        key: "reverse-artwork",
        label: "Reverse Artwork",
        value: state.differentReverseArtwork ? "Different from front" : "Same as front",
      });
    }
    rows.push({ key: "repeat-order", label: "Repeat Order", value: state.repeatOrder ? "Yes" : "No" });
  }

  for (const group of catalog.optionGroups) {
    const selectedId = state.selectedOptionValueIds[group.name];
    if (!selectedId) continue;
    const value = group.values.find((v) => v.id === selectedId);
    if (!value) continue;
    rows.push({ key: `option:${group.name}`, label: group.name, value: value.label });
  }

  if (state.productionCode) {
    const rule = catalog.productionRules.find((r) => r.code === state.productionCode);
    rows.push({ key: "production", label: "Production", value: rule?.name ?? state.productionCode });
  }

  if (result?.packaging) {
    rows.push({ key: "packaging", label: "Packaging", value: result.packaging.name });
  }

  return rows;
}

/** Human-readable snapshot of the current configuration for the Request-a-Quote
 * placeholder (STEP 14). Delegates to `buildSelectedConfigurationRows` — the quote
 * snapshot and the Price Summary show the same normalized rows, never two hand-built
 * label sets. No priced `result` is threaded through here, so the Quantity row shows
 * the quantity alone. */
export function buildQuoteSummary(
  catalog: PricingCatalog,
  state: ProductConfigurationState,
): SelectedConfigurationRow[] {
  return buildSelectedConfigurationRows(catalog, state);
}

/** What the selected decoration method can price on this product (from the catalog). `null`
 * when no method is selected or the catalog predates capabilities. */
export function decorationCapabilitiesFor(catalog: PricingCatalog, method: string | null) {
  return catalog.decorationCapabilities?.find((c) => c.method === method) ?? null;
}

/**
 * Keeps the decoration selections inside what the chosen method's pricing rules can satisfy.
 * Offering "2 locations" for a method with no second-location charge (or a repeat order with
 * no repeat-order charge) makes every calculation fail, so anything unsupported is reset to
 * its neutral value. Returns the same object when nothing needed to change.
 */
export function clampDecorationToCapabilities(state: ProductConfigurationState, catalog: PricingCatalog): ProductConfigurationState {
  const caps = decorationCapabilitiesFor(catalog, state.decorationMethod);
  const colors = (caps?.maxColors ?? 1) >= 2 ? state.colors : 1;
  const locations = caps?.secondLocation ? state.locations : 1;
  const reverseSide = caps?.reverseSide ? state.reverseSide : false;
  const differentReverseArtwork = reverseSide ? state.differentReverseArtwork : false;
  const repeatOrder = caps?.repeatOrder ? state.repeatOrder : false;
  if (
    colors === state.colors &&
    locations === state.locations &&
    reverseSide === state.reverseSide &&
    differentReverseArtwork === state.differentReverseArtwork &&
    repeatOrder === state.repeatOrder
  ) {
    return state;
  }
  return { ...state, colors, locations, reverseSide, differentReverseArtwork, repeatOrder };
}

const FRIENDLY_PRICING_ERRORS: Record<string, string> = {
  DECORATION_RULE_NOT_FOUND: "This combination of imprint options isn't priced for this product. Try a simpler selection.",
  COLOR_PRICING_UNAVAILABLE: "This product has no price for that number of imprint colors. Choose fewer colors.",
  OPTION_PRICING_UNAVAILABLE: "One of the selected options has no price yet, so it can't be included.",
  QUANTITY_BELOW_MINIMUM: "That quantity is below the minimum order for this product.",
  QUANTITY_TIER_NOT_FOUND: "No quantity pricing is set up for this product.",
  INVALID_QUANTITY: "Enter a whole number quantity of 1 or more.",
  PRICING_PROFILE_NOT_FOUND: "No pricing profile is linked to this product yet.",
  PRICING_PROFILE_INACTIVE: "This product's pricing profile is turned off.",
  PRODUCTION_RULE_NOT_FOUND: "That production option isn't available for this product.",
  MISSING_REQUIRED_OPTION_GROUP: "A required option hasn't been chosen yet.",
};

/** Plain-language text for a pricing failure. The engine's own message (which names internal
 * rule codes) is only used for codes this map doesn't cover. */
export function friendlyPricingErrorMessage(code: string | undefined, fallback: string): string {
  return (code && FRIENDLY_PRICING_ERRORS[code]) || fallback;
}
