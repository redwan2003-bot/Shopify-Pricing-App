import type { PrismaClient } from "@prisma/client";
import { validatePricingProfileImport } from "./validate.ts";
import type {
  ImportResult,
  ImportValidationIssue,
  PricingProfileImportInput,
} from "./types.ts";

export class PricingImportValidationError extends Error {
  readonly issues: ImportValidationIssue[];

  constructor(issues: ImportValidationIssue[]) {
    super(
      `Pricing import validation failed with ${issues.length} issue(s):\n` +
        issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n"),
    );
    this.name = "PricingImportValidationError";
    this.issues = issues;
  }
}

/**
 * Imports (creates or updates) one product's full pricing configuration.
 *
 * Idempotent: running the same input twice produces the same end state, never
 * duplicate rows. The Store is upserted by shopDomain, the PricingProfile is upserted
 * by (storeId, sku), and every child collection (quantity tiers, decoration rules,
 * option groups/values, production rules, packaging rules) is replaced in place under
 * that same profile id inside one transaction — so a re-import cleanly reflects
 * corrected source data instead of accumulating stale rows next to new ones.
 *
 * This function is intentionally generic: it accepts any product's pricing package in
 * the shape defined by PricingProfileImportInput, not just LNY01. See
 * prisma/seed-data/lny01.ts for the first concrete input, and prisma/seed.ts for how
 * it's invoked.
 */
export async function importPricingProfile(
  prisma: PrismaClient,
  input: PricingProfileImportInput,
): Promise<ImportResult> {
  const validation = validatePricingProfileImport(input);
  if (!validation.valid) {
    throw new PricingImportValidationError(validation.errors);
  }

  return prisma.$transaction(async (tx) => {
    const store = await tx.store.upsert({
      where: { shopDomain: input.shopDomain },
      update: {},
      create: { shopDomain: input.shopDomain },
    });

    const profile = await tx.pricingProfile.upsert({
      where: { storeId_sku: { storeId: store.id, sku: input.sku } },
      update: {
        name: input.name,
        description: input.description ?? null,
        isDefault: input.isDefault ?? false,
        isActive: true,
        currency: input.currency ?? "USD",
      },
      create: {
        storeId: store.id,
        sku: input.sku,
        name: input.name,
        description: input.description ?? null,
        isDefault: input.isDefault ?? false,
        currency: input.currency ?? "USD",
      },
    });

    await tx.quantityTier.deleteMany({
      where: { pricingProfileId: profile.id },
    });
    await tx.quantityTier.createMany({
      data: input.quantityTiers.map((tier) => ({
        pricingProfileId: profile.id,
        minQuantity: tier.minQuantity,
        maxQuantity: tier.maxQuantity ?? null,
        priceCode: tier.priceCode ?? null,
        listPriceCents: tier.listPriceCents,
        netPriceCents: tier.netPriceCents,
      })),
    });

    await tx.decorationRule.deleteMany({
      where: { pricingProfileId: profile.id },
    });
    await tx.decorationRule.createMany({
      data: input.decorationRules.map((rule, index) => ({
        pricingProfileId: profile.id,
        method: rule.method,
        code: rule.code,
        name: rule.name,
        chargeBasis: rule.chargeBasis,
        priceCode: rule.priceCode ?? null,
        listPriceCents: rule.listPriceCents,
        netPriceCents: rule.netPriceCents,
        sortOrder: rule.sortOrder ?? index,
      })),
    });

    await tx.decorationColorCharge.deleteMany({
      where: { pricingProfileId: profile.id },
    });
    const decorationColorCharges = input.decorationColorCharges ?? [];
    await tx.decorationColorCharge.createMany({
      data: decorationColorCharges.map((charge) => ({
        pricingProfileId: profile.id,
        method: charge.method,
        colorNumber: charge.colorNumber,
        chargeBasis: charge.chargeBasis,
        priceCode: charge.priceCode ?? null,
        listPriceCents: charge.listPriceCents,
        netPriceCents: charge.netPriceCents,
        isActive: charge.isActive ?? true,
      })),
    });

    // Deleting the OptionGroup cascades to its OptionValue rows (onDelete: Cascade).
    await tx.optionGroup.deleteMany({
      where: { pricingProfileId: profile.id },
    });
    let optionValueCount = 0;
    for (const [groupIndex, group] of input.optionGroups.entries()) {
      await tx.optionGroup.create({
        data: {
          pricingProfileId: profile.id,
          name: group.name,
          kind: group.kind ?? "GENERIC",
          isRequired: group.isRequired ?? false,
          sortOrder: group.sortOrder ?? groupIndex,
          categoryPriceAdjustmentCents: group.categoryPriceAdjustmentCents ?? null,
          optionValues: {
            create: group.values.map((value, valueIndex) => ({
              code: value.code ?? null,
              label: value.label,
              priceCode: value.priceCode ?? null,
              priceAdjustmentCents: value.priceAdjustmentCents ?? null,
              isDefault: value.isDefault ?? false,
              sortOrder: value.sortOrder ?? valueIndex,
            })),
          },
        },
      });
      optionValueCount += group.values.length;
    }

    await tx.productColor.deleteMany({
      where: { pricingProfileId: profile.id },
    });
    const productColors = input.productColors ?? [];
    await tx.productColor.createMany({
      data: productColors.map((color, index) => ({
        pricingProfileId: profile.id,
        code: color.code,
        name: color.name,
        priceCode: color.priceCode ?? null,
        priceAdjustmentCents: color.priceAdjustmentCents ?? null,
        sortOrder: color.sortOrder ?? index,
        isActive: color.isActive ?? true,
      })),
    });

    await tx.productionRule.deleteMany({
      where: { pricingProfileId: profile.id },
    });
    await tx.productionRule.createMany({
      data: input.productionRules.map((rule) => ({
        pricingProfileId: profile.id,
        code: rule.code,
        name: rule.name,
        isRush: rule.isRush ?? false,
        minBusinessDays: rule.minBusinessDays,
        maxBusinessDays: rule.maxBusinessDays ?? null,
        relatedSku: rule.relatedSku ?? null,
        feeCents: rule.feeCents ?? null,
        feeType: rule.feeType ?? "FLAT",
        notes: rule.notes ?? null,
      })),
    });

    await tx.packagingRule.deleteMany({
      where: { pricingProfileId: profile.id },
    });
    await tx.packagingRule.createMany({
      data: input.packagingRules.map((rule) => ({
        pricingProfileId: profile.id,
        code: rule.code,
        name: rule.name,
        unitsPerPackage: rule.unitsPerPackage ?? null,
        cartonWeightLbs: rule.cartonWeightLbs ?? null,
        lengthIn: rule.lengthIn ?? null,
        widthIn: rule.widthIn ?? null,
        heightIn: rule.heightIn ?? null,
        feeCents: rule.feeCents ?? null,
        notes: rule.notes ?? null,
      })),
    });

    return {
      storeId: store.id,
      shopDomain: store.shopDomain,
      pricingProfileId: profile.id,
      sku: input.sku,
      counts: {
        quantityTiers: input.quantityTiers.length,
        decorationRules: input.decorationRules.length,
        decorationColorCharges: decorationColorCharges.length,
        optionGroups: input.optionGroups.length,
        optionValues: optionValueCount,
        productColors: productColors.length,
        productionRules: input.productionRules.length,
        packagingRules: input.packagingRules.length,
      },
    };
  });
}
