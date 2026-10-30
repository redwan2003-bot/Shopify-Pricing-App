#!/usr/bin/env node
/**
 * READ-ONLY preview of the "Match profiles by SKU" action. It builds exactly the report the
 * app would apply and prints it. It never calls applyLinkReport, and the Shopify client it
 * uses refuses any GraphQL document that contains a mutation, so nothing can be written to
 * Shopify or to the database.
 *
 *   node --env-file=.env scripts/preview-sku-link.mjs --report-dir <absolute-dir> \
 *     [--resolve LDSBR34=8446376018059] [--resolve LDSSB34=8446376083595] [--include-archived]
 *
 * It reads the app's stored offline session for the shop. If that token has expired, load the
 * app once in the Shopify Admin so the app refreshes it, then run this again. The token is
 * used in memory only and is never printed or saved.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { buildLinkReport, summarizeLinkReport } from "../app/lib/pricing-import/link-products.ts";

const API_VERSION = "2026-07";

function fail(message) {
  console.error(`\nABORT: ${message}`);
  process.exit(1);
}

// ---- arguments ------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { shop: "imprintid-pricing-dev.myshopify.com", reportDir: null, includeArchived: false, resolutions: {} };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--include-archived") opts.includeArchived = true;
  else if (a === "--report-dir") opts.reportDir = argv[++i];
  else if (a.startsWith("--report-dir=")) opts.reportDir = a.slice("--report-dir=".length);
  else if (a === "--shop") opts.shop = argv[++i];
  else if (a === "--resolve" || a.startsWith("--resolve=")) {
    const pair = a === "--resolve" ? argv[++i] : a.slice("--resolve=".length);
    const [sku, ...rest] = String(pair).split("=");
    if (!sku || rest.length === 0) fail(`--resolve expects SKU=productId (got "${pair}")`);
    opts.resolutions[sku.trim()] = rest.join("=").trim();
  } else fail(`unknown argument: ${a}`);
}
if (!opts.reportDir || !isAbsolute(opts.reportDir)) fail("--report-dir <absolute-path> is required");
if (!existsSync(opts.reportDir) || !statSync(opts.reportDir).isDirectory()) fail(`--report-dir "${opts.reportDir}" is not an existing directory`);
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (run with --env-file=.env)");

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }) });

try {
  const store = await prisma.store.findUnique({ where: { shopDomain: opts.shop }, select: { id: true } });
  if (!store) fail(`no Store row for ${opts.shop}`);

  const session = await prisma.session.findFirst({ where: { shop: opts.shop, isOnline: false }, orderBy: { expires: "desc" } });
  if (!session?.accessToken) fail("no offline session for this shop; open the app in the Shopify Admin first");
  if (session.expires && session.expires.getTime() < Date.now() + 60_000) {
    fail(`the stored offline token expired at ${session.expires.toISOString()}; load the app once in the Shopify Admin to refresh it, then run this again`);
  }
  const token = session.accessToken;

  // Read-only Shopify client: queries only. The token never leaves this function.
  const admin = {
    async graphql(query, options = {}) {
      if (/\bmutation\b/i.test(query)) throw new Error("read-only client: refusing to send a GraphQL mutation");
      const res = await fetch(`https://${opts.shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables: options.variables ?? {} }),
      });
      if (!res.ok) throw new Error(`Shopify Admin API answered HTTP ${res.status}`);
      return { json: () => res.json() };
    },
  };

  const report = await buildLinkReport(prisma, admin, store.id, { includeArchived: opts.includeArchived, manualResolutions: opts.resolutions });
  const summary = summarizeLinkReport(report);

  console.log(`PREVIEW ONLY. Nothing was written to Shopify or the database.  shop=${opts.shop}`);
  console.log(`manual resolutions supplied: ${JSON.stringify(opts.resolutions)}  | archived products as candidates: ${opts.includeArchived}`);
  console.log("\n== totals");
  console.table(summary.totals);
  console.log("== held back");
  console.table(summary.heldBack);
  console.log("== blocked by override-key conflicts");
  console.log(summary.blocked.length ? JSON.stringify(summary.blocked, null, 1) : "(none)");
  console.log("== manual resolutions applied");
  console.table(summary.matched.filter((m) => m.manualResolution));
  console.log("== proposed local override changes");
  console.log(`   ${summary.proposedOverrideChanges.length} change(s); keys are BARE numeric product ids; ${summary.overridesUnchanged.length} existing override(s) left unchanged`);
  console.log(`   unchanged: ${JSON.stringify(summary.overridesUnchanged)}`);

  const file = join(opts.reportDir, `sku-link-preview-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), shop: opts.shop, resolutions: opts.resolutions, ...summary }, null, 2));
  console.log(`\nfull report (every product id, every proposed write): ${file}`);
} catch (error) {
  // Never echo a token or connection string.
  const text = String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/gi, "<url>").replace(/shp[a-z]{2}_[A-Za-z0-9]+/g, "<token>");
  console.error(`ERROR: ${text.slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
