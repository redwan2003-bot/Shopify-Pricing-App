import { PrismaClient } from "@prisma/client";
import { importPricingProfile, PricingImportValidationError } from "../app/lib/pricing-import/import.ts";
import { buildLny01PricingInput } from "./seed-data/lny01.ts";

/**
 * Development-environment shop domain used when SEED_SHOP_DOMAIN is not set. This is a
 * default for local seeding only, not something baked into the schema/architecture —
 * every pricing record is still stored against a normal Store row keyed by whatever
 * shopDomain is passed in.
 */
const DEFAULT_DEV_SHOP_DOMAIN = "imprintid-pricing-dev.myshopify.com";
const DEFAULT_LNY01_PRODUCT_ID = "8438071820427";

async function main() {
  const shopDomain = process.env.SEED_SHOP_DOMAIN?.trim() || DEFAULT_DEV_SHOP_DOMAIN;
  const prisma = new PrismaClient();

  try {
    console.log(`Seeding pricing data for shop: ${shopDomain}`);

    const result = await importPricingProfile(prisma, buildLny01PricingInput(shopDomain));

    // Keep the local seed self-contained so the development storefront and
    // integration tests exercise the product-override resolution path.
    await prisma.productPricingOverride.upsert({
      where: {
        storeId_shopifyProductId: {
          storeId: result.storeId,
          shopifyProductId: DEFAULT_LNY01_PRODUCT_ID,
        },
      },
      update: {
        pricingProfileId: result.pricingProfileId,
        isActive: true,
      },
      create: {
        storeId: result.storeId,
        shopifyProductId: DEFAULT_LNY01_PRODUCT_ID,
        pricingProfileId: result.pricingProfileId,
        isActive: true,
      },
    });

    console.log("\nLNY01 pricing import complete:");
    console.log(`  Store:            ${result.shopDomain} (${result.storeId})`);
    console.log(`  PricingProfile:   ${result.sku} (${result.pricingProfileId})`);
    console.log(`  Quantity tiers:      ${result.counts.quantityTiers}`);
    console.log(`  Decoration rules:    ${result.counts.decorationRules}`);
    console.log(`  Color charges:       ${result.counts.decorationColorCharges}`);
    console.log(`  Option groups:       ${result.counts.optionGroups}`);
    console.log(`  Option values:       ${result.counts.optionValues}`);
    console.log(`  Product colors:      ${result.counts.productColors}`);
    console.log(`  Production rules:    ${result.counts.productionRules}`);
    console.log(`  Packaging rules:     ${result.counts.packagingRules}`);
    console.log(
      "\nNote: no ProductPricingOverride was created — LNY01 has no known Shopify " +
        "product ID yet. Link it once the product exists in the store (see " +
        "prisma/seed-data/README.md).",
    );
  } catch (error) {
    if (error instanceof PricingImportValidationError) {
      console.error("Pricing import validation failed:");
      for (const issue of error.issues) {
        console.error(`  - ${issue.path}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main();
