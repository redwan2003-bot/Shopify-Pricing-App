import {
  DecorationMethod,
  DecorationChargeBasis,
  OptionGroupKind,
  ProductionFeeType,
} from "@prisma/client";
import type {
  ImportValidationIssue,
  ImportValidationResult,
  PricingProfileImportInput,
} from "./types.ts";

const VALID_DECORATION_METHODS = new Set<string>(
  Object.values(DecorationMethod),
);
const VALID_CHARGE_BASES = new Set<string>(
  Object.values(DecorationChargeBasis),
);
const VALID_FEE_TYPES = new Set<string>(Object.values(ProductionFeeType));
const VALID_OPTION_GROUP_KINDS = new Set<string>(Object.values(OptionGroupKind));

/** True for a value that is absent (validation treats it as "not supplied"). */
function isOmitted(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Integer cents, required, must be present and >= 0. */
function checkRequiredMoney(
  value: unknown,
  path: string,
  errors: ImportValidationIssue[],
) {
  if (isOmitted(value)) {
    errors.push({ path, message: "is required and must be an integer number of cents" });
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push({ path, message: "must be an integer (cents) — floating-point money is not allowed" });
    return;
  }
  if (value < 0) {
    errors.push({ path, message: "must not be negative" });
  }
}

/** Integer cents, optional: null/undefined means "not supplied" and is valid. */
function checkOptionalMoney(
  value: unknown,
  path: string,
  errors: ImportValidationIssue[],
) {
  if (isOmitted(value)) return;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push({ path, message: "must be an integer (cents) when supplied — floating-point money is not allowed" });
    return;
  }
  if (value < 0) {
    errors.push({ path, message: "must not be negative" });
  }
}

function checkNonEmptyString(
  value: unknown,
  path: string,
  errors: ImportValidationIssue[],
) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ path, message: "is required and must be a non-empty string" });
  }
}

/**
 * Validates a structured pricing import package. Returns every problem found rather
 * than throwing on the first one, so a caller (CLI, seed script, future admin UI) can
 * report a complete list of what needs fixing in the source data.
 */
export function validatePricingProfileImport(
  input: PricingProfileImportInput,
): ImportValidationResult {
  const errors: ImportValidationIssue[] = [];

  checkNonEmptyString(input.shopDomain, "shopDomain", errors);
  checkNonEmptyString(input.sku, "sku", errors);
  checkNonEmptyString(input.name, "name", errors);

  validateQuantityTiers(input, errors);
  validateDecorationRules(input, errors);
  validateDecorationColorCharges(input, errors);
  validateOptionGroups(input, errors);
  validateProductColors(input, errors);
  validateProductionRules(input, errors);
  validatePackagingRules(input, errors);

  return { valid: errors.length === 0, errors };
}

function validateQuantityTiers(
  input: PricingProfileImportInput,
  errors: ImportValidationIssue[],
) {
  if (!Array.isArray(input.quantityTiers) || input.quantityTiers.length === 0) {
    errors.push({ path: "quantityTiers", message: "at least one quantity tier is required" });
    return;
  }

  const seenMinQuantities = new Set<number>();

  input.quantityTiers.forEach((tier, index) => {
    const path = `quantityTiers[${index}]`;

    if (typeof tier.minQuantity !== "number" || !Number.isInteger(tier.minQuantity)) {
      errors.push({ path: `${path}.minQuantity`, message: "must be an integer" });
    } else if (tier.minQuantity <= 0) {
      errors.push({ path: `${path}.minQuantity`, message: "must be positive" });
    } else if (seenMinQuantities.has(tier.minQuantity)) {
      errors.push({ path: `${path}.minQuantity`, message: `duplicate quantity tier for minQuantity=${tier.minQuantity}` });
    } else {
      seenMinQuantities.add(tier.minQuantity);
    }

    if (!isOmitted(tier.maxQuantity)) {
      if (typeof tier.maxQuantity !== "number" || !Number.isInteger(tier.maxQuantity)) {
        errors.push({ path: `${path}.maxQuantity`, message: "must be an integer when supplied" });
      } else if (
        typeof tier.minQuantity === "number" &&
        tier.maxQuantity < tier.minQuantity
      ) {
        errors.push({ path: `${path}.maxQuantity`, message: "must not be less than minQuantity" });
      }
    }

    checkRequiredMoney(tier.listPriceCents, `${path}.listPriceCents`, errors);
    checkRequiredMoney(tier.netPriceCents, `${path}.netPriceCents`, errors);
    if (
      typeof tier.listPriceCents === "number" &&
      typeof tier.netPriceCents === "number" &&
      Number.isInteger(tier.listPriceCents) &&
      Number.isInteger(tier.netPriceCents) &&
      tier.netPriceCents > tier.listPriceCents
    ) {
      errors.push({ path: `${path}.netPriceCents`, message: "must not exceed listPriceCents" });
    }
  });
}

function validateDecorationRules(
  input: PricingProfileImportInput,
  errors: ImportValidationIssue[],
) {
  if (!Array.isArray(input.decorationRules)) {
    errors.push({ path: "decorationRules", message: "must be an array (may be empty)" });
    return;
  }

  const seenCodes = new Set<string>();

  input.decorationRules.forEach((rule, index) => {
    const path = `decorationRules[${index}]`;

    checkNonEmptyString(rule.code, `${path}.code`, errors);
    if (typeof rule.code === "string" && rule.code.trim().length > 0) {
      if (seenCodes.has(rule.code)) {
        errors.push({ path: `${path}.code`, message: `duplicate decoration rule code "${rule.code}"` });
      } else {
        seenCodes.add(rule.code);
      }
    }

    checkNonEmptyString(rule.name, `${path}.name`, errors);

    if (!VALID_DECORATION_METHODS.has(rule.method)) {
      errors.push({ path: `${path}.method`, message: `must be one of: ${[...VALID_DECORATION_METHODS].join(", ")}` });
    }
    if (!VALID_CHARGE_BASES.has(rule.chargeBasis)) {
      errors.push({ path: `${path}.chargeBasis`, message: `must be one of: ${[...VALID_CHARGE_BASES].join(", ")}` });
    }

    checkRequiredMoney(rule.listPriceCents, `${path}.listPriceCents`, errors);
    checkRequiredMoney(rule.netPriceCents, `${path}.netPriceCents`, errors);
  });
}

function validateDecorationColorCharges(
  input: PricingProfileImportInput,
  errors: ImportValidationIssue[],
) {
  const charges = input.decorationColorCharges;
  if (charges === undefined) return;
  if (!Array.isArray(charges)) {
    errors.push({ path: "decorationColorCharges", message: "must be an array when supplied" });
    return;
  }

  const seenKeys = new Set<string>();

  charges.forEach((charge, index) => {
    const path = `decorationColorCharges[${index}]`;

    if (!VALID_DECORATION_METHODS.has(charge.method)) {
      errors.push({ path: `${path}.method`, message: `must be one of: ${[...VALID_DECORATION_METHODS].join(", ")}` });
    }
    if (!VALID_CHARGE_BASES.has(charge.chargeBasis)) {
      errors.push({ path: `${path}.chargeBasis`, message: `must be one of: ${[...VALID_CHARGE_BASES].join(", ")}` });
    }

    if (typeof charge.colorNumber !== "number" || !Number.isInteger(charge.colorNumber)) {
      errors.push({ path: `${path}.colorNumber`, message: "must be an integer" });
    } else if (charge.colorNumber < 2) {
      errors.push({
        path: `${path}.colorNumber`,
        message: "must be >= 2 — color 1 is covered by the method's base setup charge, not this table",
      });
    }

    const key = `${charge.method}:${charge.colorNumber}:${charge.chargeBasis}`;
    if (seenKeys.has(key)) {
      errors.push({
        path,
        message: `duplicate decoration color charge for method "${charge.method}", color ${charge.colorNumber}, basis "${charge.chargeBasis}"`,
      });
    } else {
      seenKeys.add(key);
    }

    checkRequiredMoney(charge.listPriceCents, `${path}.listPriceCents`, errors);
    checkRequiredMoney(charge.netPriceCents, `${path}.netPriceCents`, errors);
    if (
      typeof charge.listPriceCents === "number" &&
      typeof charge.netPriceCents === "number" &&
      Number.isInteger(charge.listPriceCents) &&
      Number.isInteger(charge.netPriceCents) &&
      charge.netPriceCents > charge.listPriceCents
    ) {
      errors.push({ path: `${path}.netPriceCents`, message: "must not exceed listPriceCents" });
    }
  });
}

function validateProductColors(
  input: PricingProfileImportInput,
  errors: ImportValidationIssue[],
) {
  const colors = input.productColors;
  if (colors === undefined) return;
  if (!Array.isArray(colors)) {
    errors.push({ path: "productColors", message: "must be an array when supplied" });
    return;
  }

  const seenCodes = new Set<string>();

  colors.forEach((color, index) => {
    const path = `productColors[${index}]`;

    checkNonEmptyString(color.code, `${path}.code`, errors);
    if (typeof color.code === "string" && color.code.trim().length > 0) {
      if (seenCodes.has(color.code)) {
        errors.push({ path: `${path}.code`, message: `duplicate product color code "${color.code}"` });
      } else {
        seenCodes.add(color.code);
      }
    }

    checkNonEmptyString(color.name, `${path}.name`, errors);
    checkOptionalMoney(color.priceAdjustmentCents, `${path}.priceAdjustmentCents`, errors);
  });
}

function validateOptionGroups(
  input: PricingProfileImportInput,
  errors: ImportValidationIssue[],
) {
  if (!Array.isArray(input.optionGroups)) {
    errors.push({ path: "optionGroups", message: "must be an array (may be empty)" });
    return;
  }

  const seenGroupNames = new Set<string>();

  input.optionGroups.forEach((group, groupIndex) => {
    const path = `optionGroups[${groupIndex}]`;

    checkNonEmptyString(group.name, `${path}.name`, errors);
    if (typeof group.name === "string" && group.name.trim().length > 0) {
      if (seenGroupNames.has(group.name)) {
        errors.push({ path: `${path}.name`, message: `duplicate option group name "${group.name}"` });
      } else {
        seenGroupNames.add(group.name);
      }
    }

    checkOptionalMoney(
      group.categoryPriceAdjustmentCents,
      `${path}.categoryPriceAdjustmentCents`,
      errors,
    );

    if (!isOmitted(group.kind) && !VALID_OPTION_GROUP_KINDS.has(group.kind as string)) {
      errors.push({ path: `${path}.kind`, message: `must be one of: ${[...VALID_OPTION_GROUP_KINDS].join(", ")}` });
    }

    if (!Array.isArray(group.values) || group.values.length === 0) {
      errors.push({ path: `${path}.values`, message: "at least one option value is required" });
      return;
    }

    const seenLabels = new Set<string>();

    group.values.forEach((value, valueIndex) => {
      const valuePath = `${path}.values[${valueIndex}]`;

      checkNonEmptyString(value.label, `${valuePath}.label`, errors);
      if (typeof value.label === "string" && value.label.trim().length > 0) {
        if (seenLabels.has(value.label)) {
          errors.push({ path: `${valuePath}.label`, message: `duplicate option value label "${value.label}" in group "${group.name}"` });
        } else {
          seenLabels.add(value.label);
        }
      }

      checkOptionalMoney(
        value.priceAdjustmentCents,
        `${valuePath}.priceAdjustmentCents`,
        errors,
      );
    });
  });
}

function validateProductionRules(
  input: PricingProfileImportInput,
  errors: ImportValidationIssue[],
) {
  if (!Array.isArray(input.productionRules) || input.productionRules.length === 0) {
    errors.push({ path: "productionRules", message: "at least one production rule is required" });
    return;
  }

  const seenCodes = new Set<string>();

  input.productionRules.forEach((rule, index) => {
    const path = `productionRules[${index}]`;

    checkNonEmptyString(rule.code, `${path}.code`, errors);
    if (typeof rule.code === "string" && rule.code.trim().length > 0) {
      if (seenCodes.has(rule.code)) {
        errors.push({ path: `${path}.code`, message: `duplicate production rule code "${rule.code}"` });
      } else {
        seenCodes.add(rule.code);
      }
    }

    checkNonEmptyString(rule.name, `${path}.name`, errors);

    if (typeof rule.minBusinessDays !== "number" || !Number.isInteger(rule.minBusinessDays)) {
      errors.push({ path: `${path}.minBusinessDays`, message: "must be an integer" });
    } else if (rule.minBusinessDays <= 0) {
      errors.push({ path: `${path}.minBusinessDays`, message: "must be positive" });
    }

    if (!isOmitted(rule.maxBusinessDays)) {
      if (typeof rule.maxBusinessDays !== "number" || !Number.isInteger(rule.maxBusinessDays)) {
        errors.push({ path: `${path}.maxBusinessDays`, message: "must be an integer when supplied" });
      } else if (
        typeof rule.minBusinessDays === "number" &&
        rule.maxBusinessDays < rule.minBusinessDays
      ) {
        errors.push({ path: `${path}.maxBusinessDays`, message: "must not be less than minBusinessDays" });
      }
    }

    if (!isOmitted(rule.feeType) && !VALID_FEE_TYPES.has(rule.feeType as string)) {
      errors.push({ path: `${path}.feeType`, message: `must be one of: ${[...VALID_FEE_TYPES].join(", ")}` });
    }

    checkOptionalMoney(rule.feeCents, `${path}.feeCents`, errors);
  });
}

function validatePackagingRules(
  input: PricingProfileImportInput,
  errors: ImportValidationIssue[],
) {
  if (!Array.isArray(input.packagingRules) || input.packagingRules.length === 0) {
    errors.push({ path: "packagingRules", message: "at least one packaging rule is required" });
    return;
  }

  const seenCodes = new Set<string>();

  input.packagingRules.forEach((rule, index) => {
    const path = `packagingRules[${index}]`;

    checkNonEmptyString(rule.code, `${path}.code`, errors);
    if (typeof rule.code === "string" && rule.code.trim().length > 0) {
      if (seenCodes.has(rule.code)) {
        errors.push({ path: `${path}.code`, message: `duplicate packaging rule code "${rule.code}"` });
      } else {
        seenCodes.add(rule.code);
      }
    }

    checkNonEmptyString(rule.name, `${path}.name`, errors);

    if (!isOmitted(rule.unitsPerPackage)) {
      if (typeof rule.unitsPerPackage !== "number" || !Number.isInteger(rule.unitsPerPackage)) {
        errors.push({ path: `${path}.unitsPerPackage`, message: "must be an integer when supplied" });
      } else if (rule.unitsPerPackage <= 0) {
        errors.push({ path: `${path}.unitsPerPackage`, message: "must be positive when supplied" });
      }
    }

    for (const dim of ["cartonWeightLbs", "lengthIn", "widthIn", "heightIn"] as const) {
      const value = rule[dim];
      if (!isOmitted(value)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push({ path: `${path}.${dim}`, message: "must be a number when supplied" });
        } else if (value <= 0) {
          errors.push({ path: `${path}.${dim}`, message: "must be positive when supplied" });
        }
      }
    }

    checkOptionalMoney(rule.feeCents, `${path}.feeCents`, errors);
  });
}
