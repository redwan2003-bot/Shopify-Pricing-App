import type { PrismaClient } from "@prisma/client";
import { calculatePricingFromProfile } from "./calculator.ts";
import { loadPricingContext } from "./repository.ts";
import type { CalculationInput, PricingCalculationResult } from "./types.ts";

/**
 * The pricing calculation engine's single public entry point.
 *
 * PRODUCT + QUANTITY + DECORATION + OPTIONS + PRODUCTION  →  PricingCalculationResult
 *
 * Loads the relevant PricingProfile from Prisma (tenant-scoped — see repository.ts)
 * and runs the pure calculation over it (see calculator.ts). Throws a `PricingError`
 * subclass (see errors.ts) for anything the database can't support; never returns a
 * guessed or partial price.
 *
 * This is the seam later phases build on: a future API route or Shopify theme
 * extension calls this exact function with a `PrismaClient` (e.g. the app's shared
 * `app/db.server.ts` instance) and a `CalculationInput` — no calculation logic needs
 * to move or be duplicated. See docs/pricing-engine.md.
 */
export async function calculatePrice(
  prisma: PrismaClient,
  input: CalculationInput,
): Promise<PricingCalculationResult> {
  const context = await loadPricingContext(prisma, {
    shopDomain: input.shopDomain,
    sku: input.sku,
    shopifyProductId: input.shopifyProductId ?? null,
  });
  return calculatePricingFromProfile(context.profile, context.source, input);
}

export { calculatePricingFromProfile, resolveOptionValuePrice } from "./calculator.ts";
export type { ResolvedOptionPrice } from "./calculator.ts";
export { loadPricingContext } from "./repository.ts";
export type { PricingContext, PricingContextRef } from "./repository.ts";

export * from "./errors.ts";
export type {
  CalculationInput,
  DecorationSelectionInput,
  OptionSelectionInput,
  ProductionSelectionInput,
  PackagingSelectionInput,
  PricingProfileData,
  PricingSource,
  PricingCalculationResult,
  QuantityTierResult,
  BasePriceResult,
  DecorationChargeLine,
  DecorationResult,
  OptionSelectionResult,
  OptionsResult,
  ProductionResult,
  PackagingResult,
} from "./types.ts";
