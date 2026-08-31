import type {
  DecorationMethod,
  DecorationChargeBasis,
  OptionGroupKind,
  ProductionFeeType,
} from "@prisma/client";

/**
 * Structured input contract for importing one product's pricing configuration.
 * This is the shape a future CSV/JSON source is normalized into before it reaches
 * `importPricingProfile`. It is not tied to LNY01 — any product's pricing package
 * can be expressed as one of these.
 */
export interface PricingProfileImportInput {
  shopDomain: string;
  sku: string;
  name: string;
  description?: string | null;
  isDefault?: boolean;
  currency?: string;
  quantityTiers: QuantityTierInput[];
  decorationRules: DecorationRuleInput[];
  /** Per-color decoration charges (Phase 2.7) — see DecorationColorChargeInput. May be
   * empty for products whose decoration pricing doesn't vary by color count. */
  decorationColorCharges?: DecorationColorChargeInput[];
  optionGroups: OptionGroupInput[];
  /** Product colors (Phase 2.7) — see ProductColorInput. May be empty when no color
   * data has been sourced for this product; that's valid, not a gap to fill in. */
  productColors?: ProductColorInput[];
  productionRules: ProductionRuleInput[];
  packagingRules: PackagingRuleInput[];
}

/** A single quantity break. `listPriceCents`/`netPriceCents` are both required — see
 * the PricingProfile pricing-semantics note in prisma/schema.prisma. `priceCode`
 * (Phase 2.7) is optional vendor price-sheet metadata, never a substitute price. */
export interface QuantityTierInput {
  minQuantity: number;
  maxQuantity?: number | null;
  priceCode?: string | null;
  listPriceCents: number;
  netPriceCents: number;
}

/** One structured decoration charge. `code` must be unique within the product's
 * decoration rules and is the key used to make re-imports idempotent. */
export interface DecorationRuleInput {
  method: DecorationMethod;
  code: string;
  name: string;
  chargeBasis: DecorationChargeBasis;
  priceCode?: string | null;
  listPriceCents: number;
  netPriceCents: number;
  sortOrder?: number;
}

/** One charge for the Nth decoration color (Phase 2.7). `colorNumber` must be >= 2 —
 * the first color is covered by the method's base setup charge (e.g. SETUP_1C1L), not
 * this table. A given (method, colorNumber) pair may have both a ONE_TIME (setup) and
 * a PER_UNIT (run) entry — see prisma/schema.prisma#DecorationColorCharge. */
export interface DecorationColorChargeInput {
  method: DecorationMethod;
  colorNumber: number;
  chargeBasis: DecorationChargeBasis;
  priceCode?: string | null;
  listPriceCents: number;
  netPriceCents: number;
  isActive?: boolean;
}

/** A selectable option group (e.g. "Attachment — Heavy Duty"). `categoryPriceAdjustmentCents`
 * is for source data that prices a whole category rather than each option individually.
 * `kind` (Phase 2.7) lets the catalog API distinguish Attachment/Feature groups from
 * generic ones without matching on `name` text; defaults to GENERIC. */
export interface OptionGroupInput {
  name: string;
  kind?: OptionGroupKind;
  isRequired?: boolean;
  sortOrder?: number;
  categoryPriceAdjustmentCents?: number | null;
  values: OptionValueInput[];
}

/** One value within an OptionGroup. Omit `priceAdjustmentCents` (or pass null/undefined)
 * when the source data does not supply a price for this specific option — that must not
 * be normalized to 0. Pass 0 only when the source confirms the option is free. */
export interface OptionValueInput {
  code?: string | null;
  label: string;
  priceCode?: string | null;
  priceAdjustmentCents?: number | null;
  isDefault?: boolean;
  sortOrder?: number;
}

/** A selectable product color (Phase 2.7) — see prisma/schema.prisma#ProductColor.
 * Omit `priceAdjustmentCents` when color doesn't affect price for this product (a
 * valid, common case — the color still exists as a configuration dimension). */
export interface ProductColorInput {
  code: string;
  name: string;
  priceCode?: string | null;
  priceAdjustmentCents?: number | null;
  sortOrder?: number;
  isActive?: boolean;
}

/** A production/turnaround option (e.g. standard vs. rush). `code` must be unique
 * within the product's production rules and is the idempotent-import key. */
export interface ProductionRuleInput {
  code: string;
  name: string;
  isRush?: boolean;
  minBusinessDays: number;
  maxBusinessDays?: number | null;
  relatedSku?: string | null;
  feeCents?: number | null;
  feeType?: ProductionFeeType;
  notes?: string | null;
}

/** Physical packaging/carton data for one packing configuration. `code` must be unique
 * within the product's packaging rules and is the idempotent-import key. */
export interface PackagingRuleInput {
  code: string;
  name: string;
  unitsPerPackage?: number | null;
  cartonWeightLbs?: number | null;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
  feeCents?: number | null;
  notes?: string | null;
}

export interface ImportValidationIssue {
  path: string;
  message: string;
}

export interface ImportValidationResult {
  valid: boolean;
  errors: ImportValidationIssue[];
}

export interface ImportResultCounts {
  quantityTiers: number;
  decorationRules: number;
  decorationColorCharges: number;
  optionGroups: number;
  optionValues: number;
  productColors: number;
  productionRules: number;
  packagingRules: number;
}

export interface ImportResult {
  storeId: string;
  shopDomain: string;
  pricingProfileId: string;
  sku: string;
  counts: ImportResultCounts;
}
