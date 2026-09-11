import type { PrismaClient } from "@prisma/client";
import { loadPricingContext, resolveOptionValuePrice } from "../pricing/index.ts";

/**
 * A read-only, non-calculating projection of a pricing profile: what the customer
 * *can* select, not a priced result. Exists because the Phase 2.6 storefront UI needs
 * to render real option/production choices (STEP 8: "Do NOT hardcode attachment names
 * or prices into the frontend") but `calculatePrice`'s result only echoes back what
 * was already selected, never the full catalog of choices.
 *
 * This is deliberately NOT a second pricing engine or a second pricing API: it does no
 * arithmetic and reuses `loadPricingContext` (the exact same Phase 2.3 function
 * `calculatePrice` itself calls) for tenant-scoped profile loading — the same store
 * resolution, the same SKU/override precedence, the same isActive check. It only
 * re-shapes the same already-loaded `PricingProfileData` into a browsable form. See
 * docs/storefront-pricing-ui.md ("Why a catalog endpoint exists").
 *
 * Phase 2.7: extended to also expose product colors, each OptionGroup's `kind`
 * (Attachment/Feature/Generic — see prisma/schema.prisma#OptionGroupKind), per-color
 * decoration pricing, and `priceCode` wherever the schema carries one. Only inactive
 * rows are still excluded (same convention as before); internal database ids are
 * exposed only where the storefront genuinely needs them to submit a selection
 * (OptionValue.id — see CalculationInput#OptionSelectionInput) — everything else uses
 * stable public codes instead (e.g. ProductColor.code, ProductionRule.code).
 */
export interface PricingCatalogQuantityTier {
  minQuantity: number;
  maxQuantity: number | null;
  priceCode: string | null;
  listUnitPriceCents: number;
  netUnitPriceCents: number;
}

export interface PricingCatalogOptionValue {
  id: string;
  code: string | null;
  label: string;
  priceCode: string | null;
  /** null = no price was supplied for this specific option — see
   * `categoryPriceAdjustmentCents` on the enclosing group for a possible fallback.
   * Mirrors the same null-means-"not supplied" convention used everywhere else in
   * this pricing system. Kept alongside `resolvedPriceCents`/`priceSource` below (not
   * replaced by them) so a caller that wants the two raw inputs can still see them. */
  priceAdjustmentCents: number | null;
  /**
   * The price this option would actually charge, per the exact same precedence
   * `calculatePrice()` uses when this option is selected — see
   * `app/lib/pricing/calculator.ts#resolveOptionValuePrice`, the single shared
   * implementation both this catalog projection and the real calculation call. `null`
   * only when `priceSource` is `"unavailable"` (neither this option nor its group's
   * category price was ever supplied) — never a fabricated `0`. Added so the
   * storefront can display a price without re-implementing this precedence itself.
   */
  resolvedPriceCents: number | null;
  /** The NET price this option would actually charge at checkout — distinct from
   * `resolvedPriceCents` (list) only when the source data supplied a separate net
   * figure for this option. Same null convention as `resolvedPriceCents`. */
  resolvedNetPriceCents: number | null;
  /** Which field `resolvedPriceCents` came from — `"option"` (this value's own
   * price), `"category"` (the enclosing group's `categoryPriceAdjustmentCents`), or
   * `"unavailable"` (neither was supplied; selecting this option would fail
   * calculation with `OptionPricingUnavailable`, not silently charge $0). */
  priceSource: "option" | "category" | "unavailable";
}

export interface PricingCatalogOptionGroup {
  name: string;
  /** "ATTACHMENT" | "FEATURE" | "GENERIC" — lets the storefront distinguish an
   * Attachment selector from a generic option group without matching on `name` text. */
  kind: string;
  isRequired: boolean;
  categoryPriceAdjustmentCents: number | null;
  values: PricingCatalogOptionValue[];
}

/** A selectable product color (Phase 2.7). Active colors only — see
 * prisma/schema.prisma#ProductColor for why an inactive color is excluded entirely
 * rather than returned with a flag. */
export interface PricingCatalogProductColor {
  code: string;
  name: string;
  priceCode: string | null;
  priceAdjustmentCents: number | null;
}

/** One charge for the Nth decoration color (Phase 2.7) — informational, so the
 * storefront can show "color 2: +$0.35 setup, +$0.20/unit" before the customer
 * commits to a color count; the actual applied charges still come from a real
 * calculation, never computed client-side from these numbers. */
export interface PricingCatalogDecorationColorCharge {
  method: string;
  colorNumber: number;
  chargeBasis: string;
  priceCode: string | null;
  listPriceCents: number;
  netPriceCents: number;
}

export interface PricingCatalogProductionRule {
  code: string;
  name: string;
  isRush: boolean;
  minBusinessDays: number;
  maxBusinessDays: number | null;
  relatedSku: string | null;
  feeCents: number | null;
  notes: string | null;
}

/** Task 4A: canonical Shopify identity + how the profile was resolved. Present only
 * when the caller supplied Shopify product/variant ids (the storefront always does);
 * `null` for a legacy SKU-only catalog lookup. Internal DB ids are never included. */
export interface PricingCatalogIdentity {
  shopifyProductId: string;
  shopifyVariantId: string;
  resolutionSource: "product_override" | "sku";
}

export interface PricingCatalog {
  sku: string | null;
  identity: PricingCatalogIdentity | null;
  quantityTiers: PricingCatalogQuantityTier[];
  productColors: PricingCatalogProductColor[];
  decorationMethods: string[];
  decorationColorCharges: PricingCatalogDecorationColorCharge[];
  optionGroups: PricingCatalogOptionGroup[];
  productionRules: PricingCatalogProductionRule[];
}

export interface LoadPricingCatalogRef {
  sku: string;
  /** Validated bare decimal id (see product-resolver.ts). Enables ProductPricingOverride
   * resolution and populates `identity` on the response. */
  shopifyProductId?: string | null;
  /** Validated bare decimal id — echoed into `identity` only; not used to price. */
  shopifyVariantId?: string | null;
}

export async function loadPricingCatalog(
  prisma: PrismaClient,
  shopDomain: string,
  ref: string | LoadPricingCatalogRef,
): Promise<PricingCatalog> {
  const normalized: LoadPricingCatalogRef = typeof ref === "string" ? { sku: ref } : ref;
  const { profile, source } = await loadPricingContext(prisma, {
    shopDomain,
    sku: normalized.sku,
    shopifyProductId: normalized.shopifyProductId ?? null,
  });

  const identity: PricingCatalogIdentity | null =
    normalized.shopifyProductId && normalized.shopifyVariantId
      ? {
          shopifyProductId: normalized.shopifyProductId,
          shopifyVariantId: normalized.shopifyVariantId,
          resolutionSource: source.resolvedVia === "override" ? "product_override" : "sku",
        }
      : null;

  const decorationMethods = [...new Set(profile.decorationRules.map((r) => r.method))];

  return {
    identity,
    sku: profile.sku,
    quantityTiers: [...profile.quantityTiers]
      .sort((a, b) => a.minQuantity - b.minQuantity)
      .map((t) => ({
        minQuantity: t.minQuantity,
        maxQuantity: t.maxQuantity,
        priceCode: t.priceCode,
        listUnitPriceCents: t.listPriceCents,
        netUnitPriceCents: t.netPriceCents,
      })),
    productColors: profile.productColors
      .filter((c) => c.isActive)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((c) => ({
        code: c.code,
        name: c.name,
        priceCode: c.priceCode,
        priceAdjustmentCents: c.priceAdjustmentCents,
      })),
    decorationMethods,
    decorationColorCharges: profile.decorationColorCharges
      .filter((c) => c.isActive)
      .sort((a, b) => a.colorNumber - b.colorNumber)
      .map((c) => ({
        method: c.method,
        colorNumber: c.colorNumber,
        chargeBasis: c.chargeBasis,
        priceCode: c.priceCode,
        listPriceCents: c.listPriceCents,
        netPriceCents: c.netPriceCents,
      })),
    optionGroups: profile.optionGroups.map((g) => ({
      name: g.name,
      kind: g.kind,
      isRequired: g.isRequired,
      categoryPriceAdjustmentCents: g.categoryPriceAdjustmentCents,
      values: g.optionValues.map((v) => {
        const resolved = resolveOptionValuePrice(v, g.categoryPriceAdjustmentCents);
        return {
          id: v.id,
          code: v.code,
          label: v.label,
          priceCode: v.priceCode,
          priceAdjustmentCents: v.priceAdjustmentCents,
          resolvedPriceCents: resolved.cents,
          resolvedNetPriceCents: resolved.netCents,
          priceSource: resolved.source,
        };
      }),
    })),
    productionRules: profile.productionRules.map((r) => ({
      code: r.code,
      name: r.name,
      isRush: r.isRush,
      minBusinessDays: r.minBusinessDays,
      maxBusinessDays: r.maxBusinessDays,
      relatedSku: r.relatedSku,
      feeCents: r.feeCents,
      notes: r.notes,
    })),
  };
}
