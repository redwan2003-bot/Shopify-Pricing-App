/**
 * Command-line version of the "link products" step of the app's Import pricing page: links each
 * pricing profile of DEV_STORE to its Shopify product by SKU and writes the app-owned
 * `$app:imprintid/pricing_policy` metafield (profile id + revision) plus a local override.
 * Shares app/lib/pricing-import/link-products.ts with the page. Must be re-run after any import
 * that changes pricing. Never enables enforcement.
 *
 * Usage:
 *   node scripts/shopify/link-catalog-pricing.mjs --check    read-only drift report (exit 1 if out of sync)
 *   node scripts/shopify/link-catalog-pricing.mjs --dry-run  show what would be written
 *   node scripts/shopify/link-catalog-pricing.mjs            write missing/stale policies + local overrides
 */
import { PrismaClient } from "@prisma/client";
import { connectAdmin } from "./runtime.mjs";
import { DEV_STORE } from "./constants.mjs";
import { buildLinkReport, applyLinkReport } from "../../app/lib/pricing-import/link-products.ts";

async function main() {
  const check = process.argv.includes("--check");
  const dryRun = process.argv.includes("--dry-run");
  const prisma = new PrismaClient();
  const { gql } = await connectAdmin();
  // Adapt runtime.mjs's `gql(query, variables) -> data` to the Admin client shape the library uses.
  const admin = { graphql: async (query, options) => ({ json: async () => ({ data: await gql(query, options?.variables ?? {}) }) }) };

  const store = await prisma.store.findUnique({ where: { shopDomain: DEV_STORE } });
  if (!store) throw new Error(`no local Store row for ${DEV_STORE}`);
  console.log(`Target shop: ${DEV_STORE}${check ? " (CHECK — read only)" : dryRun ? " (DRY RUN)" : ""}`);

  const report = await buildLinkReport(prisma, admin, store.id);
  const c = report.counts;
  console.log(`Matched ${report.matched.length}, held back ${report.heldBack.length}`);
  console.log(`Shopify policy metafields: ${c.ok} in sync, ${c.stale} stale, ${c.missing} missing, ${c.malformed} malformed`);
  console.log(`Local overrides present for matched products: ${report.overridesPresent} of ${report.matched.length}\n`);

  if (check) {
    for (const p of report.problems.slice(0, 25)) console.log(`  ${p.status.padEnd(9)} ${p.sku} (${p.productGid})`);
    const drift = report.problems.length > 0 || report.overridesPresent !== report.matched.length;
    console.log(drift ? "\nOUT OF SYNC — run without --check to fix." : "\nIn sync.");
    process.exitCode = drift ? 1 : 0;
  } else if (dryRun) {
    for (const m of report.toWrite) console.log(`  would write ${m.profile.sku} -> ${m.title} (${m.productGid})`);
  } else {
    const result = await applyLinkReport(prisma, admin, store.id, report);
    console.log(`Wrote ${result.written} of ${report.toWrite.length} policy metafields that needed it; local overrides ensured for ${report.matched.length}.`);
    for (const e of result.errors) console.error(`  error: ${e}`);
  }
  if (report.heldBack.length) {
    console.log(`\n--- Held back (${report.heldBack.length}) ---`);
    for (const h of report.heldBack) console.log(`  ${h.sku}: ${h.reason}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
