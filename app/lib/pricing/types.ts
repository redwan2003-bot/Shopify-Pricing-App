import type { DecorationMethod, DecorationChargeBasis, OptionGroupKind } from "@prisma/client";

// ---------------------------------------------------------------------------
// Calculation input
// ---------------------------------------------------------------------------

/**
 * One selected option value. Selection is by `optionValueId` (OptionValue.id — the
 * real, globally unique primary key) plus the `groupName` the caller believes it
 * belongs to (OptionGroup.name — the real unique key within a profile). Both are
 * required: the engine looks the value up across the whole profile and rejects the
 * selection if it doesn't actually belong to the stated group (see
 * errors.ts#OptionValueGroupMismatch). This is deliberately not the spec-sketch
 * `{ groupCode, valueCode }` shape — `OptionValue.code` is not unique even within one
 * group in the real seed data (e.g. LNY01's "SA04" labels two different items), so it
 * cannot be used as a selection key. See docs/pricing-engine.md.
 */
export interface OptionSelectionInput {
  groupName: string;
  optionValueId: string;
}

/**
 * Decoration configuration for one calculation. `method` must match a
 * `DecorationRule.method` present on the profile. The remaining fields are the
 * configuration axes the LNY01 seed data's decoration codes are keyed to — see
 * calculator.ts's `DECORATION_CODES` table and docs/pricing-engine.md for exactly
 * which axis triggers which code, and the documented interpretation of each.
 */
export interface DecorationSelectionInput {
  method: DecorationMethod;
  /** Total imprint colors, including the first. Must be >= 1. */
  colors: number;
  /** Total print locations, including the front. Must be >= 1; > 2 is not priceable
   * with the current seed data (only a single "2nd location" charge exists). */
  locations: number;
  /** Whether the reverse/back side is printed at all. */
  reverseSide: boolean;
  /** Whether the reverse side uses different artwork than the front. Only meaningful
   * when `reverseSide` is true; only this combination triggers a priced setup charge
   * in the current seed data (reusing identical art on the reverse has no priced
   * line item in the source sheet). */
  differentReverseArtwork: boolean;
  /** Whether this order is a repeat of a previous order (triggers the reduced
   * repeat-order setup charge in place of a full setup, per the source sheet — see
   * docs/pricing-engine.md for how this combines with the base setup charge). */
  repeatOrder: boolean;
}

/** Selects a ProductColor by its `code` (Phase 2.7). Omit when color doesn't matter
 * for this calculation — this is not a required dimension the way a decoration
 * selection can be; a profile with no configured colors, or a caller that never
 * selects one, is entirely valid. */
export interface ProductColorSelectionInput {
  code: string;
}

/** Selects a ProductionRule by its `code`. Omit to use the profile's unique
 * non-rush rule as the default (an error is thrown if that default isn't unambiguous). */
export interface ProductionSelectionInput {
  code?: string;
}

/** Selects a PackagingRule by its `code`. Omit to use the profile's single
 * packaging rule (an error is thrown if the profile has more than one and none
 * was specified). */
export interface PackagingSelectionInput {
  code?: string;
}

/**
 * Input to `calculatePrice`. Tenant-scoped by `shopDomain` (Store's real external
 * unique key — matching the convention already used by
 * `app/lib/pricing-import`) rather than an internal `storeId`; the resolved internal
 * `storeId` still strictly scopes every query underneath (see repository.ts).
 *
 * `shopifyProductId` is optional and enables ProductPricingOverride-based profile
 * resolution (see repository.ts for precedence). LNY01 has no known Shopify product
 * ID yet, so in practice today every LNY01 calculation resolves by `sku` alone.
 */
export interface CalculationInput {
  shopDomain: string;
  sku: string;
  shopifyProductId?: string | null;
  quantity: number;
  productColor?: ProductColorSelectionInput;
  decoration?: DecorationSelectionInput;
  options?: OptionSelectionInput[];
  production?: ProductionSelectionInput;
  packaging?: PackagingSelectionInput;
}

// ---------------------------------------------------------------------------
// Pricing profile data (the DB-shaped, but Prisma-decoupled, input to the pure
// calculator — see repository.ts#toPricingProfileData for the Prisma → this mapping)
// ---------------------------------------------------------------------------

export interface QuantityTierData {
  id: string;
  minQuantity: number;
  maxQuantity: number | null;
  priceCode: string | null;
  listPriceCents: number;
  netPriceCents: number;
}

export interface DecorationRuleData {
  id: string;
  method: DecorationMethod;
  code: string;
  name: string;
  chargeBasis: DecorationChargeBasis;
  priceCode: string | null;
  listPriceCents: number;
  netPriceCents: number;
}

/** One charge for the Nth decoration color (Phase 2.7) — see
 * prisma/schema.prisma#DecorationColorCharge and calculator.ts's per-color loop. */
export interface DecorationColorChargeData {
  id: string;
  method: DecorationMethod;
  colorNumber: number;
  chargeBasis: DecorationChargeBasis;
  priceCode: string | null;
  listPriceCents: number;
  netPriceCents: number;
  isActive: boolean;
}

export interface OptionValueData {
  id: string;
  code: string | null;
  label: string;
  priceCode: string | null;
  priceAdjustmentCents: number | null;
  /** Net (actually-charged) price adjustment, when the source supplied one separately
   * from `priceAdjustmentCents` (list). null means "not supplied", not "same as list"
   * — the calculator falls back to `priceAdjustmentCents` for both totals in that case. */
  netPriceAdjustmentCents: number | null;
}

export interface OptionGroupData {
  id: string;
  name: string;
  kind: OptionGroupKind;
  isRequired: boolean;
  categoryPriceAdjustmentCents: number | null;
  optionValues: OptionValueData[];
}

/** A selectable product color (Phase 2.7) — see prisma/schema.prisma#ProductColor. */
export interface ProductColorData {
  id: string;
  code: string;
  name: string;
  priceCode: string | null;
  priceAdjustmentCents: number | null;
  isActive: boolean;
}

export interface ProductionRuleData {
  id: string;
  code: string;
  name: string;
  isRush: boolean;
  minBusinessDays: number;
  maxBusinessDays: number | null;
  relatedSku: string | null;
  feeCents: number | null;
  notes: string | null;
}

export interface PackagingRuleData {
  id: string;
  code: string;
  name: string;
  unitsPerPackage: number | null;
  cartonWeightLbs: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  feeCents: number | null;
}

export interface PricingProfileData {
  id: string;
  sku: string | null;
  isActive: boolean;
  quantityTiers: QuantityTierData[];
  decorationRules: DecorationRuleData[];
  decorationColorCharges: DecorationColorChargeData[];
  optionGroups: OptionGroupData[];
  productColors: ProductColorData[];
  productionRules: ProductionRuleData[];
  packagingRules: PackagingRuleData[];
}

export interface PricingSource {
  storeId: string;
  shopDomain: string;
  pricingProfileId: string;
  pricingProfileSku: string | null;
  /** How the profile was resolved: via a ProductPricingOverride, or directly by SKU. */
  resolvedVia: "override" | "sku";
}

// ---------------------------------------------------------------------------
// Calculation result
// ---------------------------------------------------------------------------

export interface QuantityTierResult {
  id: string;
  minQuantity: number;
  maxQuantity: number | null;
  priceCode: string | null;
  listUnitPriceCents: number;
  netUnitPriceCents: number;
}

/** The resolved product color for one calculation, if `productColor` was selected in
 * the input. `priceAdjustmentCents` follows the same convention as everywhere else in
 * this system: null means "no price was supplied for this color" (contributes 0 to
 * totals but is reported distinctly from a confirmed $0). */
export interface ProductColorResult {
  code: string;
  name: string;
  priceCode: string | null;
  priceAdjustmentCents: number | null;
}

export interface BasePriceResult {
  quantity: number;
  listUnitPriceCents: number;
  netUnitPriceCents: number;
  listSubtotalCents: number;
  netSubtotalCents: number;
}

export interface DecorationChargeLine {
  code: string;
  name: string;
  chargeBasis: DecorationChargeBasis;
  /** How many times this charge's per-occurrence price is applied: 1 for ONE_TIME,
   * the order quantity for PER_UNIT. */
  occurrences: number;
  listPriceCents: number;
  netPriceCents: number;
  listLineTotalCents: number;
  netLineTotalCents: number;
}

export interface DecorationResult {
  method: DecorationMethod;
  charges: DecorationChargeLine[];
  listChargesCents: number;
  netChargesCents: number;
}

export interface OptionSelectionResult {
  groupName: string;
  optionValueId: string;
  optionLabel: string;
  /** Whether the price came from the option itself or its group's category-level
   * price — see errors.ts#OptionPricingUnavailable for when neither is available. */
  source: "option" | "category";
  priceAdjustmentCents: number;
  /** Resolved net price for this selection — equal to `priceAdjustmentCents` unless
   * the source data supplied a distinct net price for this option (or its category
   * has none, so the same value is used for both). See `OptionValueData`. */
  netPriceAdjustmentCents: number;
}

export interface OptionsResult {
  selections: OptionSelectionResult[];
  /** Sum of each selection's list `priceAdjustmentCents`, per piece. */
  perUnitChargesCents: number;
  /** Sum of each selection's `netPriceAdjustmentCents`, per piece — what is charged for each
   * unit. Equal to `perUnitChargesCents` unless a selected option has a distinct net price. */
  netPerUnitChargesCents: number;
  /** `perUnitChargesCents` x quantity — the order-level list amount; feeds `totals.listTotalCents`. */
  chargesCents: number;
  /** `netPerUnitChargesCents` x quantity — the order-level net amount; feeds `totals.netTotalCents`. */
  netChargesCents: number;
}

export interface ProductionResult {
  code: string;
  name: string;
  isRush: boolean;
  minBusinessDays: number;
  maxBusinessDays: number | null;
  relatedSku: string | null;
  /** null = no fee was supplied for this rule (contributes 0 to totals, but is
   * reported as null rather than 0 so a UI can show "no surcharge" vs. "$0.00"). */
  feeCents: number | null;
  notes: string | null;
}

export interface PackagingResult {
  code: string;
  name: string;
  unitsPerPackage: number | null;
  cartonWeightLbs: number | null;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  /** null = no packaging fee was supplied (contributes 0 to totals; see ProductionResult). */
  feeCents: number | null;
}

export interface PricingCalculationResult {
  source: PricingSource;
  quantity: number;
  quantityTier: QuantityTierResult;
  /** Every quantity tier configured on the profile, sorted ascending by
   * `minQuantity` — read-only reference data for rendering a quantity-break table
   * (e.g. "order 1000+ for $0.98/unit"). Added for Phase 2.6's storefront UI; purely
   * additive, computed from the same `profile.quantityTiers` `quantityTier` above
   * already uses — no new calculation rule. */
  availableQuantityTiers: QuantityTierResult[];
  base: BasePriceResult;
  /** null only when no `productColor` selection was supplied in the input. */
  productColor: ProductColorResult | null;
  /** null only when no `decoration` selection was supplied in the input. */
  decoration: DecorationResult | null;
  options: OptionsResult;
  production: ProductionResult;
  /** null only when the profile has no PackagingRule configured at all. */
  packaging: PackagingResult | null;
  totals: {
    listTotalCents: number;
    netTotalCents: number;
  };
}
