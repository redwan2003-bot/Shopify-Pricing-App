import type { DecorationMethod } from "@prisma/client";
import {
  ColorPricingUnavailable,
  DecorationRuleNotFound,
  DuplicateOptionSelection,
  InvalidDecorationSelection,
  InvalidOptionGroup,
  InvalidOptionValue,
  InvalidQuantity,
  MissingRequiredOptionGroup,
  OptionPricingUnavailable,
  OptionValueGroupMismatch,
  PricingConfigurationInvalid,
  ProductColorNotFound,
  ProductionRuleNotFound,
  QuantityBelowMinimum,
  QuantityTierNotFound,
} from "./errors.ts";
import type {
  BasePriceResult,
  CalculationInput,
  DecorationChargeLine,
  DecorationColorChargeData,
  DecorationResult,
  DecorationRuleData,
  OptionGroupData,
  OptionSelectionInput,
  OptionSelectionResult,
  OptionsResult,
  PackagingResult,
  PricingCalculationResult,
  PricingProfileData,
  PricingSource,
  ProductColorResult,
  ProductionResult,
  QuantityTierData,
  QuantityTierResult,
} from "./types.ts";

/**
 * Known decoration-rule codes and the configuration axis each one is gated by. This is
 * a vocabulary of *identifiers*, not a price table — every dollar amount still comes
 * from the matching DecorationRule row in the database. See docs/pricing-engine.md
 * ("Decoration calculation") for the full reasoning, including the interpretation call
 * made here because the schema has no way to encode it directly: `locations` and
 * `reverseSide`/`differentReverseArtwork` are treated as independent axes, matching how
 * the two source line items ("2nd Location Run Charge" and "Reverse Side Setup — if
 * different art") are named and priced independently in the seed data.
 *
 * Additional-color pricing is NOT in this table — as of Phase 2.7 it's resolved from
 * `DecorationColorCharge` rows (one per method + color number), not a fixed code; see
 * `resolveAdditionalColorCharges` below and docs/pricing-model-expansion.md.
 */
const DECORATION_CODES = {
  baseSetup: "SETUP_1C1L",
  reverseSideSetup: "REVERSE_SIDE_SETUP",
  secondLocationRun: "SECOND_LOCATION_RUN",
  repeatOrderSetup: "REPEAT_ORDER_SETUP",
} as const;

/**
 * Selects the quantity tier for a requested quantity: the highest tier whose
 * `minQuantity` is <= the requested quantity. `maxQuantity` is informational only —
 * tier boundaries are determined entirely by `minQuantity`, so a gap or overlap in
 * `maxQuantity` values (there shouldn't be one) can never change which tier is chosen.
 */
function selectQuantityTier(
  tiers: QuantityTierData[],
  quantity: number,
): QuantityTierData {
  const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);
  const lowest = sorted[0];
  if (!lowest || quantity < lowest.minQuantity) {
    throw new QuantityBelowMinimum(quantity, lowest?.minQuantity ?? 0);
  }

  let selected = lowest;
  for (const tier of sorted) {
    if (tier.minQuantity <= quantity) {
      selected = tier;
    } else {
      break;
    }
  }
  return selected;
}

function toDecorationLine(rule: DecorationRuleData, quantity: number): DecorationChargeLine {
  const occurrences = rule.chargeBasis === "PER_UNIT" ? quantity : 1;
  return {
    code: rule.code,
    name: rule.name,
    chargeBasis: rule.chargeBasis,
    occurrences,
    listPriceCents: rule.listPriceCents,
    netPriceCents: rule.netPriceCents,
    listLineTotalCents: rule.listPriceCents * occurrences,
    netLineTotalCents: rule.netPriceCents * occurrences,
  };
}

/** Same shape as `toDecorationLine`, sourced from a `DecorationColorCharge` row
 * instead of a `DecorationRule` row. `code` is synthesized (e.g. "COLOR_2_SETUP") since
 * a color charge is identified by (method, colorNumber, chargeBasis), not its own
 * stable code — see prisma/schema.prisma#DecorationColorCharge. */
function toDecorationColorLine(
  charge: DecorationColorChargeData,
  quantity: number,
): DecorationChargeLine {
  const occurrences = charge.chargeBasis === "PER_UNIT" ? quantity : 1;
  const kind = charge.chargeBasis === "PER_UNIT" ? "RUN" : "SETUP";
  return {
    code: `COLOR_${charge.colorNumber}_${kind}`,
    name: `Color ${charge.colorNumber} ${kind === "RUN" ? "Run Charge" : "Setup Charge"}`,
    chargeBasis: charge.chargeBasis,
    occurrences,
    listPriceCents: charge.listPriceCents,
    netPriceCents: charge.netPriceCents,
    listLineTotalCents: charge.listPriceCents * occurrences,
    netLineTotalCents: charge.netPriceCents * occurrences,
  };
}

/**
 * Resolves every charge for colors 2..N (color 1 is covered by the base setup
 * elsewhere). Phase 2.7: replaces the old "colors > 1" binary gate — each additional
 * color number is looked up independently, so a profile can price color 2, 3, 4, ...
 * differently, and requesting a color count beyond what's configured is a clear error
 * rather than a silently-skipped or free charge. Active charges only — an inactive
 * `DecorationColorCharge` behaves as "not configured" for this color number, the same
 * convention used for inactive ProductColor/PricingProfile rows elsewhere.
 */
function resolveAdditionalColorCharges(
  profile: PricingProfileData,
  method: DecorationMethod,
  colors: number,
  quantity: number,
): DecorationChargeLine[] {
  const lines: DecorationChargeLine[] = [];
  for (let colorNumber = 2; colorNumber <= colors; colorNumber++) {
    const chargesForColor = profile.decorationColorCharges.filter(
      (c) => c.isActive && c.method === method && c.colorNumber === colorNumber,
    );
    if (chargesForColor.length === 0) {
      throw new ColorPricingUnavailable(method, colorNumber);
    }
    for (const charge of chargesForColor) {
      lines.push(toDecorationColorLine(charge, quantity));
    }
  }
  return lines;
}

function resolveDecoration(
  profile: PricingProfileData,
  input: NonNullable<CalculationInput["decoration"]>,
  quantity: number,
): DecorationResult {
  if (!Number.isInteger(input.colors) || input.colors < 1) {
    throw new InvalidDecorationSelection("decoration.colors must be an integer >= 1");
  }
  if (!Number.isInteger(input.locations) || input.locations < 1) {
    throw new InvalidDecorationSelection("decoration.locations must be an integer >= 1");
  }
  if (input.locations > 2) {
    throw new InvalidDecorationSelection(
      `decoration.locations=${input.locations} is not supported by the current pricing data (no rule beyond a 2nd location)`,
    );
  }

  const rulesForMethod = profile.decorationRules.filter((r) => r.method === input.method);
  if (rulesForMethod.length === 0) {
    throw new DecorationRuleNotFound(input.method, "(any rule for this method)");
  }
  const byCode = new Map(rulesForMethod.map((r) => [r.code, r]));

  function requireRule(code: string): DecorationRuleData {
    const rule = byCode.get(code);
    if (!rule) throw new DecorationRuleNotFound(input.method, code);
    return rule;
  }

  const lines: DecorationChargeLine[] = [];

  // A priceable decoration configuration always includes the base one-color,
  // one-location setup.
  lines.push(toDecorationLine(requireRule(DECORATION_CODES.baseSetup), quantity));

  if (input.colors > 1) {
    lines.push(...resolveAdditionalColorCharges(profile, input.method, input.colors, quantity));
  }

  if (input.locations === 2) {
    lines.push(toDecorationLine(requireRule(DECORATION_CODES.secondLocationRun), quantity));
  }

  if (input.reverseSide && input.differentReverseArtwork) {
    lines.push(toDecorationLine(requireRule(DECORATION_CODES.reverseSideSetup), quantity));
  }

  if (input.repeatOrder) {
    lines.push(toDecorationLine(requireRule(DECORATION_CODES.repeatOrderSetup), quantity));
  }

  const listChargesCents = lines.reduce((sum, line) => sum + line.listLineTotalCents, 0);
  const netChargesCents = lines.reduce((sum, line) => sum + line.netLineTotalCents, 0);

  return { method: input.method, charges: lines, listChargesCents, netChargesCents };
}

/** One `OptionValue`'s resolved price, and which field it came from. `cents: null` /
 * `source: "unavailable"` means neither the option nor its group's category price was
 * supplied — never treated as $0 by any caller. */
export interface ResolvedOptionPrice {
  cents: number | null;
  source: "option" | "category" | "unavailable";
}

/**
 * The one, single implementation of the option-pricing precedence rule (`OptionValue.
 * priceAdjustmentCents`, falling back to the enclosing group's `categoryPriceAdjustmentCents`)
 * — used by `resolveOptions` below (the real calculation path) AND by
 * `app/lib/pricing-api/catalog.ts` (the read-only catalog projection the storefront
 * renders prices from), so the storefront never needs its own copy of this rule. See
 * docs/pricing-architecture.md §7 for why null and 0 are never conflated here.
 */
export function resolveOptionValuePrice(
  optionValue: { priceAdjustmentCents: number | null },
  categoryPriceAdjustmentCents: number | null,
): ResolvedOptionPrice {
  if (optionValue.priceAdjustmentCents !== null) {
    return { cents: optionValue.priceAdjustmentCents, source: "option" };
  }
  if (categoryPriceAdjustmentCents !== null) {
    return { cents: categoryPriceAdjustmentCents, source: "category" };
  }
  return { cents: null, source: "unavailable" };
}

function resolveOptions(
  profile: PricingProfileData,
  selections: OptionSelectionInput[],
): OptionsResult {
  const results: OptionSelectionResult[] = [];
  const seenGroupNames = new Set<string>();

  for (const selection of selections) {
    const group = profile.optionGroups.find((g) => g.name === selection.groupName);
    if (!group) throw new InvalidOptionGroup(selection.groupName);

    if (seenGroupNames.has(group.name)) {
      throw new DuplicateOptionSelection(group.name);
    }
    seenGroupNames.add(group.name);

    let owningGroup: OptionGroupData | undefined;
    let value: OptionGroupData["optionValues"][number] | undefined;
    for (const candidateGroup of profile.optionGroups) {
      const candidateValue = candidateGroup.optionValues.find(
        (v) => v.id === selection.optionValueId,
      );
      if (candidateValue) {
        owningGroup = candidateGroup;
        value = candidateValue;
        break;
      }
    }

    if (!value || !owningGroup) throw new InvalidOptionValue(selection.optionValueId);
    if (owningGroup.id !== group.id) {
      throw new OptionValueGroupMismatch(selection.optionValueId, group.name, owningGroup.name);
    }

    const resolved = resolveOptionValuePrice(value, group.categoryPriceAdjustmentCents);
    if (resolved.source === "unavailable" || resolved.cents === null) {
      throw new OptionPricingUnavailable(group.name, value.label);
    }

    results.push({
      groupName: group.name,
      optionValueId: value.id,
      optionLabel: value.label,
      source: resolved.source,
      priceAdjustmentCents: resolved.cents,
    });
  }

  for (const group of profile.optionGroups) {
    if (group.isRequired && !seenGroupNames.has(group.name)) {
      throw new MissingRequiredOptionGroup(group.name);
    }
  }

  const chargesCents = results.reduce((sum, r) => sum + r.priceAdjustmentCents, 0);
  return { selections: results, chargesCents };
}

/**
 * Resolves the selected product color, if any (Phase 2.7). Only active colors are
 * eligible — an inactive `ProductColor` is indistinguishable from one that was never
 * configured, the same convention `PricingProfileInactive` already uses one level up.
 * Returns null when the input didn't select a color at all; that's always valid, since
 * color may be a purely informational dimension with no price impact for some products.
 */
function resolveProductColor(
  profile: PricingProfileData,
  input: CalculationInput["productColor"],
): ProductColorResult | null {
  if (!input) return null;
  const color = profile.productColors.find((c) => c.isActive && c.code === input.code);
  if (!color) throw new ProductColorNotFound(input.code);
  return {
    code: color.code,
    name: color.name,
    priceCode: color.priceCode,
    priceAdjustmentCents: color.priceAdjustmentCents,
  };
}

function resolveProduction(
  profile: PricingProfileData,
  input: CalculationInput["production"],
): ProductionResult {
  let rule;
  if (input?.code) {
    rule = profile.productionRules.find((r) => r.code === input.code);
    if (!rule) throw new ProductionRuleNotFound(input.code);
  } else {
    const nonRush = profile.productionRules.filter((r) => !r.isRush);
    if (nonRush.length !== 1) {
      throw new ProductionRuleNotFound(
        "(default)",
        "no unambiguous non-rush default — specify production.code explicitly",
      );
    }
    rule = nonRush[0]!;
  }

  return {
    code: rule.code,
    name: rule.name,
    isRush: rule.isRush,
    minBusinessDays: rule.minBusinessDays,
    maxBusinessDays: rule.maxBusinessDays,
    relatedSku: rule.relatedSku,
    feeCents: rule.feeCents,
    notes: rule.notes,
  };
}

function resolvePackaging(
  profile: PricingProfileData,
  input: CalculationInput["packaging"],
): PackagingResult | null {
  if (profile.packagingRules.length === 0) return null;

  let rule;
  if (input?.code) {
    rule = profile.packagingRules.find((r) => r.code === input.code);
    if (!rule) {
      throw new PricingConfigurationInvalid(`No PackagingRule with code "${input.code}"`);
    }
  } else if (profile.packagingRules.length === 1) {
    rule = profile.packagingRules[0]!;
  } else {
    throw new PricingConfigurationInvalid(
      "Multiple packaging rules are configured — specify packaging.code explicitly",
    );
  }

  return {
    code: rule.code,
    name: rule.name,
    unitsPerPackage: rule.unitsPerPackage,
    cartonWeightLbs: rule.cartonWeightLbs,
    lengthIn: rule.lengthIn,
    widthIn: rule.widthIn,
    heightIn: rule.heightIn,
    feeCents: rule.feeCents,
  };
}

/**
 * Pure calculation: given already-loaded pricing data for one profile (see
 * repository.ts) and a validated calculation input, computes the full price
 * breakdown. Deterministic — no I/O, no randomness, no timestamps, no
 * floating-point money. Throws a `PricingError` subclass (see errors.ts) for any
 * configuration the data can't support; never substitutes a default/zero price for
 * missing configuration.
 */
export function calculatePricingFromProfile(
  profile: PricingProfileData,
  source: PricingSource,
  input: CalculationInput,
): PricingCalculationResult {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new InvalidQuantity(input.quantity);
  }
  if (profile.quantityTiers.length === 0) {
    throw new QuantityTierNotFound(profile.id);
  }

  const tier = selectQuantityTier(profile.quantityTiers, input.quantity);
  const quantityTier: QuantityTierResult = {
    id: tier.id,
    minQuantity: tier.minQuantity,
    maxQuantity: tier.maxQuantity,
    priceCode: tier.priceCode,
    listUnitPriceCents: tier.listPriceCents,
    netUnitPriceCents: tier.netPriceCents,
  };

  const availableQuantityTiers: QuantityTierResult[] = [...profile.quantityTiers]
    .sort((a, b) => a.minQuantity - b.minQuantity)
    .map((t) => ({
      id: t.id,
      minQuantity: t.minQuantity,
      maxQuantity: t.maxQuantity,
      priceCode: t.priceCode,
      listUnitPriceCents: t.listPriceCents,
      netUnitPriceCents: t.netPriceCents,
    }));

  const base: BasePriceResult = {
    quantity: input.quantity,
    listUnitPriceCents: tier.listPriceCents,
    netUnitPriceCents: tier.netPriceCents,
    listSubtotalCents: tier.listPriceCents * input.quantity,
    netSubtotalCents: tier.netPriceCents * input.quantity,
  };

  const productColor = resolveProductColor(profile, input.productColor);
  const decoration = input.decoration
    ? resolveDecoration(profile, input.decoration, input.quantity)
    : null;
  const options = resolveOptions(profile, input.options ?? []);
  const production = resolveProduction(profile, input.production);
  const packaging = resolvePackaging(profile, input.packaging);

  const productColorCents = productColor?.priceAdjustmentCents ?? 0;
  const decorationListCents = decoration?.listChargesCents ?? 0;
  const decorationNetCents = decoration?.netChargesCents ?? 0;
  const productionFeeCents = production.feeCents ?? 0;
  const packagingFeeCents = packaging?.feeCents ?? 0;

  const listTotalCents =
    base.listSubtotalCents +
    productColorCents +
    decorationListCents +
    options.chargesCents +
    productionFeeCents +
    packagingFeeCents;
  const netTotalCents =
    base.netSubtotalCents +
    productColorCents +
    decorationNetCents +
    options.chargesCents +
    productionFeeCents +
    packagingFeeCents;

  return {
    source,
    quantity: input.quantity,
    quantityTier,
    availableQuantityTiers,
    base,
    productColor,
    decoration,
    options,
    production,
    packaging,
    totals: { listTotalCents, netTotalCents },
  };
}
