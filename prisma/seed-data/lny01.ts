import { DecorationMethod, DecorationChargeBasis, OptionGroupKind } from "@prisma/client";
import type { PricingProfileImportInput } from "../../app/lib/pricing-import/types.ts";

/**
 * LNY01 — 1" Nylon Lanyards, Screen Print pricing.
 *
 * Source: ImprintID pricing sheet supplied for Phase 2.2. Values are transcribed as
 * given — see prisma/seed-data/README.md for what was and wasn't supplied, and for the
 * standard-vs-premium attachment pricing interpretation.
 *
 * `shopDomain` is intentionally not baked in here: this file describes the product's
 * pricing, independent of which store it is imported into. The caller (prisma/seed.ts,
 * or a future import CLI) supplies the target shop domain.
 *
 * Phase 2.7: the old flat "colors > 1" ADDL_COLOR_SETUP/ADDL_COLOR_RUN DecorationRule
 * rows were replaced by `decorationColorCharges` entries for colorNumber=2, carrying
 * the exact same cent values (3500/2800 setup, 25/20 run) — a representation change,
 * not a price change; see docs/pricing-model-expansion.md ("Backward compatibility")
 * for the worked-example proof this produces an identical total. `productColors` is
 * intentionally empty: no color pricing data exists in the source sheet, and the Sage
 * reference page returned no retrievable product data either (see that same doc,
 * "Sage reference analysis") — this is documented absence, not an oversight.
 */
export function buildLny01PricingInput(
  shopDomain: string,
): PricingProfileImportInput {
  return {
    shopDomain,
    sku: "LNY01",
    name: '1" Nylon Lanyards',
    description:
      "Screen print dynamic pricing profile for SKU LNY01 (1\" Nylon Lanyards). " +
      "Not yet linked to a Shopify product — see ProductPricingOverride.",
    isDefault: true,
    currency: "USD",

    // SCREEN PRINT quantity | list price | net price
    quantityTiers: [
      { minQuantity: 100, maxQuantity: 299, listPriceCents: 229, netPriceCents: 137 },
      { minQuantity: 300, maxQuantity: 499, listPriceCents: 212, netPriceCents: 127 },
      { minQuantity: 500, maxQuantity: 999, listPriceCents: 189, netPriceCents: 113 },
      { minQuantity: 1000, maxQuantity: 2999, listPriceCents: 164, netPriceCents: 98 },
      { minQuantity: 3000, maxQuantity: 4999, listPriceCents: 142, netPriceCents: 85 },
      { minQuantity: 5000, maxQuantity: null, listPriceCents: 121, netPriceCents: 73 },
    ],

    // Screen print decoration charges. Each is its own structured row — see
    // DecorationChargeBasis: ONE_TIME (charged once per order/configuration) vs.
    // PER_UNIT (charged per produced unit).
    decorationRules: [
      {
        code: "SETUP_1C1L",
        name: "Setup Charge — One Color One Location",
        method: DecorationMethod.SCREEN_PRINT,
        chargeBasis: DecorationChargeBasis.ONE_TIME,
        listPriceCents: 4500,
        netPriceCents: 3600,
        sortOrder: 0,
      },
      {
        code: "REVERSE_SIDE_SETUP",
        name: "Reverse Side Setup (if different art)",
        method: DecorationMethod.SCREEN_PRINT,
        chargeBasis: DecorationChargeBasis.ONE_TIME,
        listPriceCents: 4000,
        netPriceCents: 3200,
        sortOrder: 1,
      },
      {
        code: "SECOND_LOCATION_RUN",
        name: "2nd Location Run Charge",
        method: DecorationMethod.SCREEN_PRINT,
        chargeBasis: DecorationChargeBasis.PER_UNIT,
        listPriceCents: 30,
        netPriceCents: 24,
        sortOrder: 4,
      },
      {
        code: "REPEAT_ORDER_SETUP",
        name: "Repeat Order Setup Charge",
        method: DecorationMethod.SCREEN_PRINT,
        chargeBasis: DecorationChargeBasis.ONE_TIME,
        listPriceCents: 2500,
        netPriceCents: 2000,
        sortOrder: 5,
      },
    ],

    // Per-color decoration pricing (Phase 2.7). The source sheet gives exactly one
    // additional-color price point ("Additional Color Setup/Run Charge") — nothing for
    // 3+ colors — so only colorNumber=2 is populated here. Requesting 3+ colors for
    // LNY01 correctly raises ColorPricingUnavailable rather than guessing a formula;
    // see docs/pricing-model-expansion.md. These are the exact same cent values the
    // old ADDL_COLOR_SETUP/ADDL_COLOR_RUN DecorationRule rows carried.
    decorationColorCharges: [
      {
        method: DecorationMethod.SCREEN_PRINT,
        colorNumber: 2,
        chargeBasis: DecorationChargeBasis.ONE_TIME,
        listPriceCents: 3500,
        netPriceCents: 2800,
      },
      {
        method: DecorationMethod.SCREEN_PRINT,
        colorNumber: 2,
        chargeBasis: DecorationChargeBasis.PER_UNIT,
        listPriceCents: 25,
        netPriceCents: 20,
      },
    ],

    // Product colors (Phase 2.7): intentionally empty. No color pricing/availability
    // data exists in the authoritative Phase 2.2 source sheet for LNY01, and the Sage
    // reference page returned no retrievable product data (see
    // docs/pricing-model-expansion.md, "Sage reference analysis") — so none was
    // invented. The capability is fully implemented and tested (see
    // app/lib/pricing/calculator.test.ts's "product color" suite) against synthetic
    // fixtures instead.
    productColors: [],

    // Attachment styles, split into one OptionGroup per pricing category. The source
    // gives a surcharge per *category*, not per individual attachment, for every
    // premium category — that surcharge lives on categoryPriceAdjustmentCents.
    // Individual OptionValue.priceAdjustmentCents is left null ("not supplied") rather
    // than copying the category price onto each item, since the source never states
    // that relationship explicitly. "Standard attachment is included" is treated as a
    // confirmed $0 category price, not a missing one. `kind: ATTACHMENT` (Phase 2.7)
    // marks these as attachment groups for the catalog API, without duplicating any of
    // this data into a separate table — see docs/pricing-model-expansion.md.
    optionGroups: [
      {
        name: "Attachment — Standard",
        kind: OptionGroupKind.ATTACHMENT,
        isRequired: false,
        sortOrder: 0,
        categoryPriceAdjustmentCents: 0,
        values: [
          { code: "SA03", label: "J Hook" },
          { code: "SA01", label: "Lobster Claw" },
          { code: "SA04", label: "Keyring" },
          { code: "SA04", label: "Non-swivel Bulldog" },
          { code: "SA02", label: "Bulldog Clip" },
        ],
      },
      {
        name: "Attachment — Heavy Duty",
        kind: OptionGroupKind.ATTACHMENT,
        isRequired: false,
        sortOrder: 1,
        categoryPriceAdjustmentCents: 23,
        values: [
          { code: "HD01", label: "Oval Hook" },
          { code: "HD02", label: "Carabiner Hook" },
          { code: "HD03", label: "Thumb Hook" },
          { code: "HD04", label: "w/ Vinyl Snap" },
        ],
      },
      {
        name: "Attachment — Dual",
        kind: OptionGroupKind.ATTACHMENT,
        isRequired: false,
        sortOrder: 2,
        categoryPriceAdjustmentCents: 20,
        values: [
          { code: "DA05", label: "Bulldog w/ Keyring" },
          { code: "DA06", label: "J-hook w/ Keyring" },
          { code: "DA07", label: "Lobster w/ Keyring" },
          { code: "DA08", label: "Bulldog Snap w/ Keyring" },
        ],
      },
      {
        name: "Attachment — Plastic",
        kind: OptionGroupKind.ATTACHMENT,
        isRequired: false,
        sortOrder: 3,
        categoryPriceAdjustmentCents: 20,
        values: [
          { code: "PA09", label: "Plastic Bulldog" },
          { code: "PA10", label: "Plastic J-Hook" },
          { code: "PA11", label: "Plastic Keyring" },
          { code: "PA12", label: "Rubber Keyring" },
        ],
      },
      {
        name: "Attachment — Black Metal",
        kind: OptionGroupKind.ATTACHMENT,
        isRequired: false,
        sortOrder: 4,
        categoryPriceAdjustmentCents: 20,
        values: [
          { code: "BK09", label: "Black Metal J-Hook" },
          { code: "BK09", label: "Black Metal Bulldog" },
          { code: "BK09", label: "Black Metal Lobster" },
          { code: "BK09", label: "Black Metal Keyring" },
        ],
      },
      {
        name: "Optional Features",
        kind: OptionGroupKind.FEATURE,
        isRequired: false,
        sortOrder: 5,
        categoryPriceAdjustmentCents: null,
        values: [
          { code: "LA01", label: "Buckle Release", priceAdjustmentCents: 30 },
          { code: "LA03", label: "Swivel Buckle Release", priceAdjustmentCents: 25 },
          { code: "LA05", label: "Velcro Breakaway", priceAdjustmentCents: 20 },
          { code: "LA02", label: "Metal Buckle Release", priceAdjustmentCents: 125 },
          { code: "LA04", label: "Safety Breakaway", priceAdjustmentCents: 25 },
          { code: "LA06", label: "Cell Phone Loop", priceAdjustmentCents: 25 },
        ],
      },
    ],

    // No rush surcharge amount was supplied — feeCents is left null (not $0) for RUSH.
    productionRules: [
      {
        code: "STANDARD",
        name: "Standard Production",
        isRush: false,
        minBusinessDays: 7,
        maxBusinessDays: 8,
        feeCents: null,
        notes: "Plus applicable transit time.",
      },
      {
        code: "RUSH",
        name: "Rush Service",
        isRush: true,
        minBusinessDays: 5,
        maxBusinessDays: 5,
        relatedSku: "LNY5RSH01",
        feeCents: null,
      },
    ],

    // No packaging fee was supplied — feeCents is left null. Dimensions/weight are
    // stored as informational data only; no shipping cost is calculated from them.
    packagingRules: [
      {
        code: "STANDARD_CARTON",
        name: "Standard Carton",
        unitsPerPackage: 250,
        cartonWeightLbs: 8.5,
        lengthIn: 12,
        widthIn: 8,
        heightIn: 6,
        feeCents: null,
      },
    ],
  };
}
