import type { Prisma, PrismaClient } from "@prisma/client";
import {
  PricingConfigurationInvalid,
  PricingProfileInactive,
  PricingProfileNotFound,
  StoreNotFound,
} from "./errors.ts";
import type { PricingProfileData, PricingSource } from "./types.ts";

const PRICING_PROFILE_INCLUDE = {
  quantityTiers: true,
  decorationRules: true,
  decorationColorCharges: true,
  optionGroups: { include: { optionValues: true } },
  productColors: true,
  productionRules: true,
  packagingRules: true,
} satisfies Prisma.PricingProfileInclude;

type LoadedPricingProfile = Prisma.PricingProfileGetPayload<{
  include: typeof PRICING_PROFILE_INCLUDE;
}>;

export interface PricingContextRef {
  shopDomain: string;
  sku: string;
  /** Optional: enables ProductPricingOverride-based resolution — see precedence
   * rules below. LNY01 has no known Shopify product ID yet, so omit this for it. */
  shopifyProductId?: string | null;
}

export interface PricingContext {
  profile: PricingProfileData;
  source: PricingSource;
}

/** Strips Prisma-only bookkeeping fields (timestamps, foreign keys) down to the plain
 * shape the pure calculator operates on — see types.ts#PricingProfileData. */
function toPricingProfileData(profile: LoadedPricingProfile): PricingProfileData {
  return {
    id: profile.id,
    sku: profile.sku,
    isActive: profile.isActive,
    quantityTiers: profile.quantityTiers.map((t) => ({
      id: t.id,
      minQuantity: t.minQuantity,
      maxQuantity: t.maxQuantity,
      priceCode: t.priceCode,
      listPriceCents: t.listPriceCents,
      netPriceCents: t.netPriceCents,
    })),
    decorationRules: profile.decorationRules.map((r) => ({
      id: r.id,
      method: r.method,
      code: r.code,
      name: r.name,
      chargeBasis: r.chargeBasis,
      priceCode: r.priceCode,
      listPriceCents: r.listPriceCents,
      netPriceCents: r.netPriceCents,
    })),
    decorationColorCharges: profile.decorationColorCharges.map((c) => ({
      id: c.id,
      method: c.method,
      colorNumber: c.colorNumber,
      chargeBasis: c.chargeBasis,
      priceCode: c.priceCode,
      listPriceCents: c.listPriceCents,
      netPriceCents: c.netPriceCents,
      isActive: c.isActive,
    })),
    optionGroups: profile.optionGroups.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      isRequired: g.isRequired,
      categoryPriceAdjustmentCents: g.categoryPriceAdjustmentCents,
      optionValues: g.optionValues.map((v) => ({
        id: v.id,
        code: v.code,
        label: v.label,
        priceCode: v.priceCode,
        priceAdjustmentCents: v.priceAdjustmentCents,
        netPriceAdjustmentCents: v.netPriceAdjustmentCents,
      })),
    })),
    productColors: profile.productColors.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      priceCode: c.priceCode,
      priceAdjustmentCents: c.priceAdjustmentCents,
      isActive: c.isActive,
    })),
    productionRules: profile.productionRules.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      isRush: r.isRush,
      minBusinessDays: r.minBusinessDays,
      maxBusinessDays: r.maxBusinessDays,
      relatedSku: r.relatedSku,
      feeCents: r.feeCents,
      notes: r.notes,
    })),
    packagingRules: profile.packagingRules.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      unitsPerPackage: r.unitsPerPackage,
      cartonWeightLbs: r.cartonWeightLbs,
      lengthIn: r.lengthIn,
      widthIn: r.widthIn,
      heightIn: r.heightIn,
      feeCents: r.feeCents,
    })),
  };
}

/**
 * Resolves and loads the pricing profile for one calculation, always scoped by
 * (Store, ...) — never by SKU alone, so pricing from one store's SKU can never leak
 * into another store's calculation (see docs/pricing-engine.md "Store isolation").
 *
 * Precedence when `ref.shopifyProductId` is given:
 *   1. Look up a ProductPricingOverride for (store, shopifyProductId).
 *      - If it exists but is inactive: PricingConfigurationInvalid.
 *      - If it exists and names a PricingProfile: that profile is used
 *        (`resolvedVia: "override"`), after confirming it belongs to the same store.
 *      - If it exists but names no profile: falls through to the SKU lookup below —
 *        the override record exists (e.g. for a future flat basePriceCents use) but
 *        doesn't redirect which profile prices this product.
 *   2. Otherwise (no shopifyProductId given, or no override found): the profile is
 *      looked up directly by (store, sku) (`resolvedVia: "sku"`).
 *
 * This is the only path in this module today that LNY01 actually exercises — it has
 * zero ProductPricingOverride rows (no known Shopify product ID yet). The override
 * path is implemented and tested (see tenant.test.ts) so a future product/API caller
 * can use it without changes here.
 */
export async function loadPricingContext(
  prisma: PrismaClient,
  ref: PricingContextRef,
): Promise<PricingContext> {
  const store = await prisma.store.findUnique({ where: { shopDomain: ref.shopDomain } });
  if (!store) throw new StoreNotFound(ref.shopDomain);

  let resolvedVia: "override" | "sku" = "sku";
  let profile: LoadedPricingProfile | null = null;

  if (ref.shopifyProductId) {
    const bareId = ref.shopifyProductId.replace(/^gid:\/\/shopify\/Product\//, "");
    const gid = `gid://shopify/Product/${bareId}`;
    const override = await prisma.productPricingOverride.findFirst({
      where: {
        storeId: store.id,
        shopifyProductId: { in: [bareId, gid] },
      },
    });

    if (override) {
      if (!override.isActive) {
        throw new PricingConfigurationInvalid(
          `ProductPricingOverride for shopifyProductId "${ref.shopifyProductId}" is inactive`,
        );
      }
      if (override.pricingProfileId) {
        const overrideProfile = await prisma.pricingProfile.findUnique({
          where: { id: override.pricingProfileId },
          include: PRICING_PROFILE_INCLUDE,
        });
        if (!overrideProfile) {
          throw new PricingConfigurationInvalid(
            `ProductPricingOverride for shopifyProductId "${ref.shopifyProductId}" points to a PricingProfile that no longer exists`,
          );
        }
        if (overrideProfile.storeId !== store.id) {
          throw new PricingConfigurationInvalid(
            `ProductPricingOverride for shopifyProductId "${ref.shopifyProductId}" points to a PricingProfile belonging to a different store`,
          );
        }
        profile = overrideProfile;
        resolvedVia = "override";
      }
      // else: override exists but names no profile — fall through to the SKU lookup.
    }
  }

  if (!profile) {
    profile = await prisma.pricingProfile.findUnique({
      where: { storeId_sku: { storeId: store.id, sku: ref.sku } },
      include: PRICING_PROFILE_INCLUDE,
    });
    resolvedVia = "sku";
  }

  if (!profile) throw new PricingProfileNotFound(ref.shopDomain, ref.sku);
  if (!profile.isActive) throw new PricingProfileInactive(ref.shopDomain, profile.sku ?? ref.sku);

  return {
    profile: toPricingProfileData(profile),
    source: {
      storeId: store.id,
      shopDomain: store.shopDomain,
      pricingProfileId: profile.id,
      pricingProfileSku: profile.sku,
      resolvedVia,
    },
  };
}
