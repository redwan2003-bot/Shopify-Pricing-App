/**
 * Command-line import of the ImprintID catalog CSV into the pricing database. Merchants use the
 * app's "Import pricing" page instead; both share app/lib/pricing-import/catalog-csv.ts.
 *
 * Usage:
 *   node scripts/import-catalog-pricing.ts <path-to-csv> [--shop <shopDomain>] [--dry-run]
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { analyzeCatalogCsv, importAnalyzedProfiles } from "../app/lib/pricing-import/catalog-csv.ts";

const DEFAULT_SHOP_DOMAIN = "imprintid-pricing-dev.myshopify.com";

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith("--"));
  const shopArgIndex = args.indexOf("--shop");
  const shopDomain = shopArgIndex >= 0 ? args[shopArgIndex + 1]! : (process.env.SEED_SHOP_DOMAIN?.trim() || DEFAULT_SHOP_DOMAIN);
  const dryRun = args.includes("--dry-run");

  if (!csvPath) {
    console.error("Usage: node scripts/import-catalog-pricing.ts <path-to-csv> [--shop <shopDomain>] [--dry-run]");
    process.exitCode = 1;
    return;
  }

  console.log(`Reading: ${csvPath}`);
  console.log(`Target shop: ${shopDomain}${dryRun ? " (DRY RUN — nothing will be written)" : ""}\n`);

  const analysis = analyzeCatalogCsv(readFileSync(csvPath, "utf8"), shopDomain);
  if (analysis.missingColumns) {
    console.error("This file has no ImprintID pricing columns — is it the right export?");
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${analysis.productsWithProfile} products with a pricing profile in the source file.\n`);
  console.log(`Ready to import: ${analysis.toImport.length}`);
  console.log(`Held back: ${analysis.holdBacks.length}\n`);

  const holdBacks = [...analysis.holdBacks];
  if (dryRun) {
    console.log("--- DRY RUN: would import ---");
    for (const { input } of analysis.toImport) console.log(`  ${input.sku} — ${input.name}`);
  } else {
    const prisma = new PrismaClient();
    try {
      const result = await importAnalyzedProfiles(prisma, analysis.toImport);
      holdBacks.push(...result.failures);
      console.log(`Imported ${result.imported} of ${analysis.toImport.length} candidate products (${result.changed} with changed pricing).`);
    } finally {
      await prisma.$disconnect();
    }
  }

  console.log(`\n--- Held back (${holdBacks.length}) — not imported, needs source data or a decision ---`);
  for (const hb of holdBacks) console.log(`  ${hb.sku} (${hb.title || "no title"}): ${hb.reason}`);
}

main();
