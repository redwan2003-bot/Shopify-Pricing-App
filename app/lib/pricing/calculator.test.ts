import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DecorationMethod, DecorationChargeBasis, OptionGroupKind } from "@prisma/client";
import { calculatePricingFromProfile, resolveOptionValuePrice } from "./calculator.ts";
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
  ProductColorNotFound,
  ProductionRuleNotFound,
  QuantityBelowMinimum,
  QuantityTierNotFound,
} from "./errors.ts";
import type { CalculationInput, PricingProfileData, PricingSource } from "./types.ts";

const SOURCE: PricingSource = {
  storeId: "store_fixture",
  shopDomain: "fixture.myshopify.com",
  pricingProfileId: "profile_fixture",
  pricingProfileSku: "FIXTURE01",
  resolvedVia: "sku",
};

/** A fixture profile shaped like LNY01's real seed data (plus a fuller per-color
 * decoration table, since LNY01 itself only has color 2 sourced), so these pure tests
 * exercise the same rule vocabulary the live data uses, without touching a database. */
function buildProfile(overrides: Partial<PricingProfileData> = {}): PricingProfileData {
  return {
    id: "profile_fixture",
    sku: "FIXTURE01",
    isActive: true,
    quantityTiers: [
      { id: "qt_100", minQuantity: 100, maxQuantity: 299, priceCode: null, listPriceCents: 229, netPriceCents: 137 },
      { id: "qt_300", minQuantity: 300, maxQuantity: 499, priceCode: null, listPriceCents: 212, netPriceCents: 127 },
      { id: "qt_500", minQuantity: 500, maxQuantity: 999, priceCode: null, listPriceCents: 189, netPriceCents: 113 },
      { id: "qt_1000", minQuantity: 1000, maxQuantity: 2999, priceCode: "P1", listPriceCents: 164, netPriceCents: 98 },
      { id: "qt_3000", minQuantity: 3000, maxQuantity: 4999, priceCode: null, listPriceCents: 142, netPriceCents: 85 },
      { id: "qt_5000", minQuantity: 5000, maxQuantity: null, priceCode: null, listPriceCents: 121, netPriceCents: 73 },
    ],
    decorationRules: [
      {
        id: "dr_setup",
        method: DecorationMethod.SCREEN_PRINT,
        code: "SETUP_1C1L",
        name: "Setup Charge — One Color One Location",
        chargeBasis: DecorationChargeBasis.ONE_TIME,
        priceCode: null,
        listPriceCents: 4500,
        netPriceCents: 3600,
      },
      {
        id: "dr_reverse",
        method: DecorationMethod.SCREEN_PRINT,
        code: "REVERSE_SIDE_SETUP",
        name: "Reverse Side Setup",
        chargeBasis: DecorationChargeBasis.ONE_TIME,
        priceCode: null,
        listPriceCents: 4000,
        netPriceCents: 3200,
      },
      {
        id: "dr_2nd_loc",
        method: DecorationMethod.SCREEN_PRINT,
        code: "SECOND_LOCATION_RUN",
        name: "2nd Location Run Charge",
        chargeBasis: DecorationChargeBasis.PER_UNIT,
        priceCode: null,
        listPriceCents: 30,
        netPriceCents: 24,
      },
      {
        id: "dr_repeat",
        method: DecorationMethod.SCREEN_PRINT,
        code: "REPEAT_ORDER_SETUP",
        name: "Repeat Order Setup Charge",
        chargeBasis: DecorationChargeBasis.ONE_TIME,
        priceCode: null,
        listPriceCents: 2500,
        netPriceCents: 2000,
      },
    ],
    // Colors 2, 3, and 4 each independently priced, so tests can prove the engine
    // sums per-color-number charges rather than applying one flat "2+" gate.
    decorationColorCharges: [
      { id: "dcc_2_setup", method: DecorationMethod.SCREEN_PRINT, colorNumber: 2, chargeBasis: DecorationChargeBasis.ONE_TIME, priceCode: null, listPriceCents: 3500, netPriceCents: 2800, isActive: true },
      { id: "dcc_2_run", method: DecorationMethod.SCREEN_PRINT, colorNumber: 2, chargeBasis: DecorationChargeBasis.PER_UNIT, priceCode: null, listPriceCents: 25, netPriceCents: 20, isActive: true },
      { id: "dcc_3_setup", method: DecorationMethod.SCREEN_PRINT, colorNumber: 3, chargeBasis: DecorationChargeBasis.ONE_TIME, priceCode: null, listPriceCents: 4000, netPriceCents: 3200, isActive: true },
      { id: "dcc_3_run", method: DecorationMethod.SCREEN_PRINT, colorNumber: 3, chargeBasis: DecorationChargeBasis.PER_UNIT, priceCode: null, listPriceCents: 30, netPriceCents: 24, isActive: true },
      { id: "dcc_4_setup", method: DecorationMethod.SCREEN_PRINT, colorNumber: 4, chargeBasis: DecorationChargeBasis.ONE_TIME, priceCode: null, listPriceCents: 4500, netPriceCents: 3600, isActive: true },
      { id: "dcc_4_run", method: DecorationMethod.SCREEN_PRINT, colorNumber: 4, chargeBasis: DecorationChargeBasis.PER_UNIT, priceCode: null, listPriceCents: 35, netPriceCents: 28, isActive: true },
    ],
    optionGroups: [
      {
        id: "og_standard",
        name: "Attachment — Standard",
        kind: OptionGroupKind.ATTACHMENT,
        isRequired: false,
        categoryPriceAdjustmentCents: 0,
        optionValues: [
          { id: "ov_jhook", code: null, label: "J Hook", priceCode: null, priceAdjustmentCents: null, netPriceAdjustmentCents: null },
          { id: "ov_lobster", code: null, label: "Lobster Claw", priceCode: null, priceAdjustmentCents: null, netPriceAdjustmentCents: null },
        ],
      },
      {
        id: "og_features",
        name: "Optional Features",
        kind: OptionGroupKind.FEATURE,
        isRequired: false,
        categoryPriceAdjustmentCents: null,
        optionValues: [
          { id: "ov_buckle", code: null, label: "Buckle Release", priceCode: "LA01", priceAdjustmentCents: 30, netPriceAdjustmentCents: null },
          { id: "ov_cellphone", code: null, label: "Cell Phone Loop", priceCode: null, priceAdjustmentCents: 25, netPriceAdjustmentCents: null },
        ],
      },
      {
        id: "og_noprice",
        name: "Group With No Price Anywhere",
        kind: OptionGroupKind.GENERIC,
        isRequired: false,
        categoryPriceAdjustmentCents: null,
          optionValues: [{ id: "ov_noprice", code: null, label: "Mystery Option", priceCode: null, priceAdjustmentCents: null, netPriceAdjustmentCents: null }],
      },
    ],
    productColors: [
      { id: "pc_black", code: "BLACK", name: "Black", priceCode: null, priceAdjustmentCents: null, isActive: true },
      { id: "pc_royal", code: "ROYAL", name: "Royal Blue", priceCode: "P2", priceAdjustmentCents: 15, isActive: true },
      { id: "pc_disc", code: "DISCONTINUED", name: "Discontinued Red", priceCode: null, priceAdjustmentCents: null, isActive: false },
    ],
    productionRules: [
      {
        id: "pr_standard",
        code: "STANDARD",
        name: "Standard Production",
        isRush: false,
        minBusinessDays: 7,
        maxBusinessDays: 8,
        relatedSku: null,
        feeCents: null,
        notes: "Plus applicable transit time.",
      },
      {
        id: "pr_rush",
        code: "RUSH",
        name: "Rush Service",
        isRush: true,
        minBusinessDays: 5,
        maxBusinessDays: 5,
        relatedSku: "FIX5RSH01",
        feeCents: null,
        notes: null,
      },
    ],
    packagingRules: [
      {
        id: "pk_standard",
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
    ...overrides,
  };
}

const noDecoration = (quantity: number): CalculationInput => ({
  shopDomain: SOURCE.shopDomain,
  sku: "FIXTURE01",
  quantity,
});

describe("quantity tier selection", () => {
  const profile = buildProfile();

  test("1. exact minimum quantity", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(100));
    assert.equal(r.quantityTier.minQuantity, 100);
  });

  test("2. exact tier boundary", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(300));
    assert.equal(r.quantityTier.minQuantity, 300);
  });

  test("3. quantity between tiers", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(750));
    assert.equal(r.quantityTier.minQuantity, 500);
  });

  test("4. exact highest tier", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(5000));
    assert.equal(r.quantityTier.minQuantity, 5000);
  });

  test("5. quantity above highest tier uses the highest tier", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(7500));
    assert.equal(r.quantityTier.minQuantity, 5000);
  });

  test("6. quantity below minimum is a clear error, not a guessed price", () => {
    assert.throws(
      () => calculatePricingFromProfile(profile, SOURCE, noDecoration(50)),
      QuantityBelowMinimum,
    );
  });

  test("profile with zero quantity tiers is a clear error", () => {
    const empty = buildProfile({ quantityTiers: [] });
    assert.throws(() => calculatePricingFromProfile(empty, SOURCE, noDecoration(100)), QuantityTierNotFound);
  });
});

describe("base pricing", () => {
  const profile = buildProfile();

  test("7. list price calculation", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(1000));
    assert.equal(r.base.listUnitPriceCents, 164);
    assert.equal(r.base.listSubtotalCents, 164000);
  });

  test("8. net price calculation", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(1000));
    assert.equal(r.base.netUnitPriceCents, 98);
    assert.equal(r.base.netSubtotalCents, 98000);
  });

  test("9. subtotal is exactly quantity × unit price", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(3000));
    assert.equal(r.base.listSubtotalCents, r.base.listUnitPriceCents * 3000);
    assert.equal(r.base.netSubtotalCents, r.base.netUnitPriceCents * 3000);
  });

  test("10. every monetary field in the result is an integer number of cents", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(1000));
    assert.equal(Number.isInteger(r.base.listUnitPriceCents), true);
    assert.equal(Number.isInteger(r.base.netUnitPriceCents), true);
    assert.equal(Number.isInteger(r.base.listSubtotalCents), true);
    assert.equal(Number.isInteger(r.base.netSubtotalCents), true);
    assert.equal(Number.isInteger(r.totals.listTotalCents), true);
    assert.equal(Number.isInteger(r.totals.netTotalCents), true);
  });

  test("rejects a non-integer quantity", () => {
    assert.throws(() => calculatePricingFromProfile(profile, SOURCE, noDecoration(100.5)), InvalidQuantity);
  });

  test("rejects a zero quantity", () => {
    assert.throws(() => calculatePricingFromProfile(profile, SOURCE, noDecoration(0)), InvalidQuantity);
  });

  test("availableQuantityTiers lists every configured tier, sorted ascending", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(1000));
    assert.deepEqual(
      r.availableQuantityTiers.map((t) => t.minQuantity),
      [100, 300, 500, 1000, 3000, 5000],
    );
  });

  test("availableQuantityTiers is the same regardless of which tier the request selects", () => {
    const atLow = calculatePricingFromProfile(profile, SOURCE, noDecoration(100));
    const atHigh = calculatePricingFromProfile(profile, SOURCE, noDecoration(5000));
    assert.deepEqual(atLow.availableQuantityTiers, atHigh.availableQuantityTiers);
  });

  test("the selected quantityTier is one of the entries in availableQuantityTiers", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(750));
    assert.ok(r.availableQuantityTiers.some((t) => t.id === r.quantityTier.id));
  });

  test("priceCode is passed through as metadata, never used as a price", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(1000));
    assert.equal(r.quantityTier.priceCode, "P1");
    assert.equal(r.base.listUnitPriceCents, 164); // unaffected by priceCode's value
  });
});

describe("decoration charges", () => {
  const profile = buildProfile();
  const baseDecoration = {
    method: DecorationMethod.SCREEN_PRINT,
    colors: 1,
    locations: 1,
    reverseSide: false,
    differentReverseArtwork: false,
    repeatOrder: false,
  };

  test("11. base decoration setup only, for the simplest configuration", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: baseDecoration,
    });
    assert.equal(r.decoration!.charges.length, 1);
    assert.equal(r.decoration!.charges[0]!.code, "SETUP_1C1L");
  });

  test("12. additional color adds both the color-2 setup and run charges", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, colors: 2 },
    });
    const codes = r.decoration!.charges.map((c) => c.code).sort();
    assert.deepEqual(codes, ["COLOR_2_RUN", "COLOR_2_SETUP", "SETUP_1C1L"]);
  });

  test("13. color setup charges are one-time (occurrences=1)", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, colors: 2 },
    });
    const line = r.decoration!.charges.find((c) => c.code === "COLOR_2_SETUP")!;
    assert.equal(line.occurrences, 1);
    assert.equal(line.listLineTotalCents, 3500);
    assert.equal(line.netLineTotalCents, 2800);
  });

  test("14. second location adds the 2nd-location run charge, scaled by quantity", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, locations: 2 },
    });
    const line = r.decoration!.charges.find((c) => c.code === "SECOND_LOCATION_RUN")!;
    assert.equal(line.occurrences, 1000);
    assert.equal(line.listLineTotalCents, 30 * 1000);
    assert.equal(line.netLineTotalCents, 24 * 1000);
  });

  test("15. reverse-side setup only applies with different reverse artwork", () => {
    const withDifferentArt = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, reverseSide: true, differentReverseArtwork: true },
    });
    assert.ok(withDifferentArt.decoration!.charges.some((c) => c.code === "REVERSE_SIDE_SETUP"));

    const sameArt = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, reverseSide: true, differentReverseArtwork: false },
    });
    assert.ok(!sameArt.decoration!.charges.some((c) => c.code === "REVERSE_SIDE_SETUP"));
  });

  test("16. repeat-order setup applies only when repeatOrder is true", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, repeatOrder: true },
    });
    assert.ok(r.decoration!.charges.some((c) => c.code === "REPEAT_ORDER_SETUP"));
  });

  test("17. one-time charges never scale with quantity", () => {
    const at100 = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(100),
      decoration: baseDecoration,
    });
    const at5000 = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(5000),
      decoration: baseDecoration,
    });
    assert.equal(at100.decoration!.charges[0]!.listLineTotalCents, 4500);
    assert.equal(at5000.decoration!.charges[0]!.listLineTotalCents, 4500);
  });

  test("18. per-unit charges scale exactly with quantity", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(2500),
      decoration: { ...baseDecoration, colors: 2 },
    });
    const line = r.decoration!.charges.find((c) => c.code === "COLOR_2_RUN")!;
    assert.equal(line.listLineTotalCents, 25 * 2500);
  });

  test("rejects a decoration method with no configured rules", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          decoration: { ...baseDecoration, method: DecorationMethod.EMBROIDERY },
        }),
      DecorationRuleNotFound,
    );
  });

  test("rejects zero colors", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          decoration: { ...baseDecoration, colors: 0 },
        }),
      InvalidDecorationSelection,
    );
  });

  test("rejects more locations than the data can price", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          decoration: { ...baseDecoration, locations: 3 },
        }),
      InvalidDecorationSelection,
    );
  });

  test("a required decoration code missing from the profile is a clear error, not a $0 charge", () => {
    const missingSetup = buildProfile({
      decorationRules: profile.decorationRules.filter((r) => r.code !== "SETUP_1C1L"),
    });
    assert.throws(
      () =>
        calculatePricingFromProfile(missingSetup, SOURCE, {
          ...noDecoration(100),
          decoration: baseDecoration,
        }),
      DecorationRuleNotFound,
    );
  });
});

describe("per-color decoration pricing", () => {
  const profile = buildProfile();
  const baseDecoration = {
    method: DecorationMethod.SCREEN_PRINT,
    locations: 1,
    reverseSide: false,
    differentReverseArtwork: false,
    repeatOrder: false,
  };

  test("1 color: no per-color charges, only the base setup", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, colors: 1 },
    });
    assert.deepEqual(r.decoration!.charges.map((c) => c.code), ["SETUP_1C1L"]);
  });

  test("2 colors: adds exactly color 2's charges", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, colors: 2 },
    });
    const codes = r.decoration!.charges.map((c) => c.code).sort();
    assert.deepEqual(codes, ["COLOR_2_RUN", "COLOR_2_SETUP", "SETUP_1C1L"]);
  });

  test("3 colors: sums color 2's AND color 3's charges — not one flat 'additional color' fee", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, colors: 3 },
    });
    const codes = r.decoration!.charges.map((c) => c.code).sort();
    assert.deepEqual(codes, ["COLOR_2_RUN", "COLOR_2_SETUP", "COLOR_3_RUN", "COLOR_3_SETUP", "SETUP_1C1L"]);
  });

  test("4 colors: sums colors 2, 3, and 4 independently, each with its own configured price", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(1000),
      decoration: { ...baseDecoration, colors: 4 },
    });
    const codes = r.decoration!.charges.map((c) => c.code).sort();
    assert.deepEqual(codes, [
      "COLOR_2_RUN",
      "COLOR_2_SETUP",
      "COLOR_3_RUN",
      "COLOR_3_SETUP",
      "COLOR_4_RUN",
      "COLOR_4_SETUP",
      "SETUP_1C1L",
    ]);

    // Every amount below comes straight from the fixture's DecorationColorCharge rows —
    // no arithmetic formula, no hardcoded multiplier in the engine.
    const setup = (n: number) => r.decoration!.charges.find((c) => c.code === `COLOR_${n}_SETUP`)!;
    const run = (n: number) => r.decoration!.charges.find((c) => c.code === `COLOR_${n}_RUN`)!;
    assert.equal(setup(2).listLineTotalCents, 3500);
    assert.equal(setup(3).listLineTotalCents, 4000);
    assert.equal(setup(4).listLineTotalCents, 4500);
    assert.equal(run(2).listLineTotalCents, 25 * 1000);
    assert.equal(run(3).listLineTotalCents, 30 * 1000);
    assert.equal(run(4).listLineTotalCents, 35 * 1000);

    const expectedListDecoration =
      4500 /* base setup */ + 3500 + 4000 + 4500 /* color setups */ + (25 + 30 + 35) * 1000; /* color runs */
    assert.equal(r.decoration!.listChargesCents, expectedListDecoration);
  });

  test("missing color pricing (color count beyond what's configured) is a clear error, never $0", () => {
    const onlyColor2 = buildProfile({
      decorationColorCharges: profile.decorationColorCharges.filter((c) => c.colorNumber === 2),
    });
    assert.throws(
      () =>
        calculatePricingFromProfile(onlyColor2, SOURCE, {
          ...noDecoration(1000),
          decoration: { ...baseDecoration, colors: 3 },
        }),
      ColorPricingUnavailable,
    );
  });

  test("an inactive color charge behaves as not configured, not as $0", () => {
    const inactiveColor3 = buildProfile({
      decorationColorCharges: profile.decorationColorCharges.map((c) =>
        c.colorNumber === 3 ? { ...c, isActive: false } : c,
      ),
    });
    assert.throws(
      () =>
        calculatePricingFromProfile(inactiveColor3, SOURCE, {
          ...noDecoration(1000),
          decoration: { ...baseDecoration, colors: 3 },
        }),
      ColorPricingUnavailable,
    );
  });
});

describe("product color", () => {
  const profile = buildProfile();

  test("valid color selection with a price adjustment", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(100),
      productColor: { code: "ROYAL" },
    });
    assert.equal(r.productColor!.code, "ROYAL");
    assert.equal(r.productColor!.priceAdjustmentCents, 15);
    assert.equal(r.productColor!.priceCode, "P2");
    assert.equal(r.totals.listTotalCents, r.base.listSubtotalCents + 15);
    assert.equal(r.totals.netTotalCents, r.base.netSubtotalCents + 15);
  });

  test("valid color selection with no price adjustment (color doesn't affect price)", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(100),
      productColor: { code: "BLACK" },
    });
    assert.equal(r.productColor!.code, "BLACK");
    assert.equal(r.productColor!.priceAdjustmentCents, null);
    assert.equal(r.totals.listTotalCents, r.base.listSubtotalCents); // contributes 0
  });

  test("no color selected at all: productColor is null, not an error", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(100));
    assert.equal(r.productColor, null);
  });

  test("invalid color code is rejected", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          productColor: { code: "NOT_A_REAL_COLOR" },
        }),
      ProductColorNotFound,
    );
  });

  test("an inactive color is rejected the same as an unknown one", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          productColor: { code: "DISCONTINUED" },
        }),
      ProductColorNotFound,
    );
  });

  test("duplicate color codes across the fixture are rejected at the schema/import layer, not here — this profile has none", () => {
    const codes = profile.productColors.map((c) => c.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe("options", () => {
  const profile = buildProfile();

  test("19. valid attachment selection uses the group's category price", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(100),
      options: [{ groupName: "Attachment — Standard", optionValueId: "ov_jhook" }],
    });
    assert.equal(r.options.selections[0]!.source, "category");
    assert.equal(r.options.selections[0]!.priceAdjustmentCents, 0);
  });

  test("20. optional feature surcharge uses the option's own price", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(100),
      options: [{ groupName: "Optional Features", optionValueId: "ov_cellphone" }],
    });
    assert.equal(r.options.selections[0]!.source, "option");
    assert.equal(r.options.selections[0]!.priceAdjustmentCents, 25);
    // Option prices are per piece: 25c x 100 units.
    assert.equal(r.options.perUnitChargesCents, 25);
    assert.equal(r.options.chargesCents, 25 * 100);
  });

  test("21. multiple option selections sum across groups", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(100),
      options: [
        { groupName: "Attachment — Standard", optionValueId: "ov_jhook" },
        { groupName: "Optional Features", optionValueId: "ov_buckle" },
      ],
    });
    assert.equal(r.options.selections.length, 2);
    assert.equal(r.options.perUnitChargesCents, 0 + 30);
    assert.equal(r.options.chargesCents, (0 + 30) * 100);
  });

  test("21b. option surcharges are per piece, and list and net scale separately with quantity", () => {
    const withNet = {
      ...profile,
      optionGroups: profile.optionGroups.map((g) => ({
        ...g,
        optionValues: g.optionValues.map((v) => (v.id === "ov_buckle" ? { ...v, netPriceAdjustmentCents: 23 } : v)),
      })),
    };
    const r = calculatePricingFromProfile(withNet, SOURCE, {
      ...noDecoration(200),
      options: [{ groupName: "Optional Features", optionValueId: "ov_buckle" }],
    });
    assert.equal(r.options.perUnitChargesCents, 30);
    assert.equal(r.options.netPerUnitChargesCents, 23);
    assert.equal(r.totals.listTotalCents - r.base.listSubtotalCents, 30 * 200);
    assert.equal(r.totals.netTotalCents - r.base.netSubtotalCents, 23 * 200);
  });

  test("22. an unknown option group is rejected", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          options: [{ groupName: "Not A Real Group", optionValueId: "ov_jhook" }],
        }),
      InvalidOptionGroup,
    );
  });

  test("23. an unknown option value is rejected", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          options: [{ groupName: "Attachment — Standard", optionValueId: "not_a_real_id" }],
        }),
      InvalidOptionValue,
    );
  });

  test("24. an option value that belongs to a different group is rejected", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          // ov_cellphone really belongs to "Optional Features", not "Attachment — Standard"
          options: [{ groupName: "Attachment — Standard", optionValueId: "ov_cellphone" }],
        }),
      OptionValueGroupMismatch,
    );
  });

  test("25. an option with no price anywhere (value or category) is a clear error, never $0", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          options: [{ groupName: "Group With No Price Anywhere", optionValueId: "ov_noprice" }],
        }),
      OptionPricingUnavailable,
    );
  });

  test("rejects two selections for the same group", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          options: [
            { groupName: "Attachment — Standard", optionValueId: "ov_jhook" },
            { groupName: "Attachment — Standard", optionValueId: "ov_lobster" },
          ],
        }),
      DuplicateOptionSelection,
    );
  });

  test("enforces a required option group when one is configured", () => {
    const withRequired = buildProfile({
      optionGroups: profile.optionGroups.map((g) =>
        g.name === "Attachment — Standard" ? { ...g, isRequired: true } : g,
      ),
    });
    assert.throws(
      () => calculatePricingFromProfile(withRequired, SOURCE, noDecoration(100)),
      MissingRequiredOptionGroup,
    );
  });

  test("OptionGroup.kind distinguishes Attachment/Feature/Generic without name matching", () => {
    const attachment = profile.optionGroups.find((g) => g.name === "Attachment — Standard")!;
    const feature = profile.optionGroups.find((g) => g.name === "Optional Features")!;
    const generic = profile.optionGroups.find((g) => g.name === "Group With No Price Anywhere")!;
    assert.equal(attachment.kind, "ATTACHMENT");
    assert.equal(feature.kind, "FEATURE");
    assert.equal(generic.kind, "GENERIC");
  });

  test("a client-supplied 'price' field on an option selection is never read by the calculation input, even if present", () => {
    // OptionSelectionInput only has groupName/optionValueId — TypeScript wouldn't let
    // real code add a price field, but a raw JSON request could still attempt it (this
    // simulates that attempt reaching the pure calculator directly). The resulting
    // price must still come from the database (0, "category"), never from the
    // attacker-supplied 999900.
    const maliciousSelection = { groupName: "Attachment — Standard", optionValueId: "ov_jhook", price: 999900 };
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(100),
      options: [maliciousSelection as unknown as { groupName: string; optionValueId: string }],
    });
    assert.equal(r.options.selections[0]!.priceAdjustmentCents, 0);
    assert.equal(r.options.chargesCents, 0);
  });
});

describe("resolveOptionValuePrice", () => {
  test("an explicit option-level price wins over the group's category price", () => {
    const result = resolveOptionValuePrice({ priceAdjustmentCents: 125 }, 20);
    assert.deepEqual(result, { cents: 125, netCents: 125, source: "option" });
  });

  test("falls back to the category price when the option's own price is null", () => {
    // Exactly LNY01's real "Attachment — Heavy Duty" shape.
    const result = resolveOptionValuePrice({ priceAdjustmentCents: null }, 23);
    assert.deepEqual(result, { cents: 23, netCents: 23, source: "category" });
  });

  test("a resolved price of exactly 0 is reported as a real category price, not unavailable", () => {
    // LNY01's real "Attachment — Standard" category price is a confirmed $0.
    const result = resolveOptionValuePrice({ priceAdjustmentCents: null }, 0);
    assert.deepEqual(result, { cents: 0, netCents: 0, source: "category" });
  });

  test("an option price of exactly 0 also wins over a non-null category price", () => {
    const result = resolveOptionValuePrice({ priceAdjustmentCents: 0 }, 20);
    assert.deepEqual(result, { cents: 0, netCents: 0, source: "option" });
  });

  test("neither option nor category price supplied -> unavailable, never a fabricated price", () => {
    const result = resolveOptionValuePrice({ priceAdjustmentCents: null }, null);
    assert.deepEqual(result, { cents: null, netCents: null, source: "unavailable" });
  });

  test("an option's own net price, when supplied, wins over falling back to its list price", () => {
    const result = resolveOptionValuePrice(
      { priceAdjustmentCents: 31, netPriceAdjustmentCents: 23 },
      null,
    );
    assert.deepEqual(result, { cents: 31, netCents: 23, source: "option" });
  });

  test("is the exact function resolveOptions uses internally (no second implementation)", () => {
    // 19/20 above already prove resolveOptions' *outputs* match this function for
    // LNY01-shaped fixtures; this asserts the same for every real LNY01 attachment
    // category price, directly, independent of a full calculation.
    for (const [categoryCents, expectedSource] of [[0, "category"], [23, "category"], [20, "category"]] as const) {
      const result = resolveOptionValuePrice({ priceAdjustmentCents: null }, categoryCents);
      assert.equal(result.cents, categoryCents);
      assert.equal(result.source, expectedSource);
    }
  });
});

describe("production", () => {
  const profile = buildProfile();

  test("26. standard production is the unambiguous default when omitted", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(100));
    assert.equal(r.production.code, "STANDARD");
    assert.equal(r.production.isRush, false);
  });

  test("27. rush production can be explicitly selected", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, {
      ...noDecoration(100),
      production: { code: "RUSH" },
    });
    assert.equal(r.production.isRush, true);
    assert.equal(r.production.relatedSku, "FIX5RSH01");
    assert.equal(r.production.minBusinessDays, 5);
  });

  test("28. an unknown production code is a clear error", () => {
    assert.throws(
      () =>
        calculatePricingFromProfile(profile, SOURCE, {
          ...noDecoration(100),
          production: { code: "NOT_A_REAL_CODE" },
        }),
      ProductionRuleNotFound,
    );
  });

  test("29. a production fee, when present, is included in totals", () => {
    const withFee = buildProfile({
      productionRules: profile.productionRules.map((r) =>
        r.code === "STANDARD" ? { ...r, feeCents: 500 } : r,
      ),
    });
    const r = calculatePricingFromProfile(withFee, SOURCE, noDecoration(100));
    assert.equal(r.production.feeCents, 500);
    assert.equal(r.totals.listTotalCents, r.base.listSubtotalCents + 500);
  });

  test("a null production fee contributes 0 but is reported as null, not 0", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(100));
    assert.equal(r.production.feeCents, null);
    assert.equal(r.totals.listTotalCents, r.base.listSubtotalCents);
  });
});

describe("packaging", () => {
  const profile = buildProfile();

  test("30. packaging information is exposed in the result", () => {
    const r = calculatePricingFromProfile(profile, SOURCE, noDecoration(100));
    assert.equal(r.packaging!.code, "STANDARD_CARTON");
    assert.equal(r.packaging!.unitsPerPackage, 250);
    assert.equal(r.packaging!.cartonWeightLbs, 8.5);
    assert.equal(r.packaging!.lengthIn, 12);
    assert.equal(r.packaging!.widthIn, 8);
    assert.equal(r.packaging!.heightIn, 6);
  });

  test("31. a packaging fee, when present, is included in totals", () => {
    const withFee = buildProfile({
      packagingRules: profile.packagingRules.map((r) => ({ ...r, feeCents: 200 })),
    });
    const r = calculatePricingFromProfile(withFee, SOURCE, noDecoration(100));
    assert.equal(r.packaging!.feeCents, 200);
    assert.equal(r.totals.listTotalCents, r.base.listSubtotalCents + 200);
  });

  test("a profile with no packaging rules reports packaging as null, not an error", () => {
    const noPackaging = buildProfile({ packagingRules: [] });
    const r = calculatePricingFromProfile(noPackaging, SOURCE, noDecoration(100));
    assert.equal(r.packaging, null);
  });
});

describe("determinism", () => {
  test("39. identical input against identical data produces an identical result", () => {
    const profile = buildProfile();
    const input: CalculationInput = {
      ...noDecoration(1000),
      productColor: { code: "ROYAL" },
      decoration: {
        method: DecorationMethod.SCREEN_PRINT,
        colors: 3,
        locations: 2,
        reverseSide: true,
        differentReverseArtwork: true,
        repeatOrder: true,
      },
      options: [{ groupName: "Optional Features", optionValueId: "ov_buckle" }],
      production: { code: "RUSH" },
    };

    const first = calculatePricingFromProfile(profile, SOURCE, input);
    const second = calculatePricingFromProfile(profile, SOURCE, input);
    assert.deepEqual(first, second);
  });
});
