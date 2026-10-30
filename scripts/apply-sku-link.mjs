#!/usr/bin/env node
/**
 * Guarded application of the "Match profiles by SKU" link. Three modes:
 *
 *   PLAN (default, writes NOTHING to Shopify or the database)
 *     node --env-file=.env scripts/apply-sku-link.mjs --report-dir <abs-dir> \
 *       --expect-preview <preview.json> --resolve LDSBR34=<id> --resolve LDSSB34=<id>
 *     Rebuilds the live report, snapshots every product's current policy metafield, checks it
 *     against the reviewed contract AND the saved preview, and writes a plan file whose hash a
 *     human approves.
 *
 *   APPLY
 *     SKU_LINK_ALLOW_WRITE=1 node --env-file=.env scripts/apply-sku-link.mjs --apply \
 *       --confirm-store <shop> --approved-plan <plan.json> --report-dir <abs-dir> \
 *       --expect-preview <preview.json> --resolve ...
 *     Refuses unless the freshly rebuilt plan hashes to the approved one. Writes a manifest
 *     BEFORE the first mutation, re-verifies each batch, writes compare-and-set, stops on any
 *     drift or failure.
 *
 *   ROLLBACK
 *     SKU_LINK_ALLOW_WRITE=1 node --env-file=.env scripts/apply-sku-link.mjs \
 *       --rollback <manifest.json> --confirm-store <shop> --report-dir <abs-dir>
 *
 * The Shopify client only ever sends: queries (all modes), and in apply the single
 * metafieldsSet mutation, in rollback metafieldsSet and metafieldsDelete. Any other
 * mutation is refused in code. The offline token is used in memory and never printed.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { METAFIELDS_DELETE_MUTATION, METAFIELDS_SET_MUTATION } from "../app/lib/catalog/admin-client.ts";
import { applySkuLinkPlan, buildSkuLinkPlan, checkContract, diffAgainstPreview, rollbackSkuLink } from "../app/lib/pricing-import/sku-link-apply.ts";

const API_VERSION = "2026-07";

/** The reviewed contract for THIS apply: what the preview showed and the owner approved. */
const CONTRACT = {
  matched: 145,
  heldBackSkus: ["LDUSY", "LDUSYSB"],
  staleWrites: 137,
  missingWrites: 8,
  overridesToCreate: 144,
  overridesUnchanged: 1,
  blocked: 0,
  legacyGidRows: 0,
};

function fail(message) {
  console.error(`\nABORT: ${message}`);
  process.exit(1);
}

// ---- arguments ------------------------------------------------------------------------
const argv = process.argv.slice(2);
const o = { shop: "imprintid-pricing-dev.myshopify.com", reportDir: null, apply: false, rollback: null, confirm: null, plan: null, preview: null, resolutions: {} };
const next = (i, name) => (argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? fail(`${name} needs a value`) : argv[i + 1]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const eq = a.includes("=") ? a.slice(a.indexOf("=") + 1) : null;
  const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
  const value = () => (eq !== null ? eq : (i++, next(i - 1, flag)));
  if (flag === "--apply") o.apply = true;
  else if (flag === "--report-dir") o.reportDir = value();
  else if (flag === "--shop") o.shop = value();
  else if (flag === "--confirm-store") o.confirm = value();
  else if (flag === "--approved-plan") o.plan = value();
  else if (flag === "--expect-preview") o.preview = value();
  else if (flag === "--rollback") o.rollback = value();
  else if (flag === "--resolve") {
    const [sku, ...rest] = value().split("=");
    if (!sku || !rest.length) fail("--resolve expects SKU=productId");
    o.resolutions[sku.trim()] = rest.join("=").trim();
  } else fail(`unknown argument: ${a}`);
}

const mode = o.rollback ? "rollback" : o.apply ? "apply" : "plan";
if (!o.reportDir || !isAbsolute(o.reportDir) || !existsSync(o.reportDir) || !statSync(o.reportDir).isDirectory()) fail("--report-dir must be an absolute path to an existing directory");
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (run with --env-file=.env)");
if (mode !== "plan") {
  if (process.env.SKU_LINK_ALLOW_WRITE !== "1") fail("writes require SKU_LINK_ALLOW_WRITE=1");
  if (o.confirm !== o.shop) fail(`writes require --confirm-store ${o.shop}`);
}
if (mode !== "rollback" && !o.preview) fail("--expect-preview <saved preview json> is required");
if (mode === "apply" && !o.plan) fail("--approved-plan <plan json from plan mode> is required to apply");

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }) });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const readJson = (path, label) => {
  if (!existsSync(path)) fail(`${label} not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
};
const writeAtomic = (path, data) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${path}.tmp`, path);
};

try {
  const store = await prisma.store.findUnique({ where: { shopDomain: o.shop }, select: { id: true } });
  if (!store) fail(`no Store row for ${o.shop}`);

  const session = await prisma.session.findFirst({ where: { shop: o.shop, isOnline: false }, orderBy: { expires: "desc" } });
  if (!session?.accessToken) fail("no offline session for this shop; open the app in the Shopify Admin first");
  const needMs = mode === "plan" ? 60_000 : 10 * 60_000;
  if (session.expires && session.expires.getTime() < Date.now() + needMs) {
    fail(`the stored offline token expires at ${session.expires.toISOString()}, too soon for this run; load the app once in the Shopify Admin to refresh it`);
  }
  const token = session.accessToken;

  const allowedMutations = mode === "apply" ? [METAFIELDS_SET_MUTATION] : mode === "rollback" ? [METAFIELDS_SET_MUTATION, METAFIELDS_DELETE_MUTATION] : [];
  const admin = {
    async graphql(query, options = {}) {
      if (/\bmutation\b/i.test(query) && !allowedMutations.includes(query)) throw new Error(`refusing to send a GraphQL mutation that ${mode} mode does not allow`);
      const res = await fetch(`https://${o.shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables: options.variables ?? {} }),
      });
      if (!res.ok) throw new Error(`Shopify Admin API answered HTTP ${res.status}`);
      return { json: () => res.json() };
    },
  };
  const deps = { prisma, admin, shop: o.shop, storeId: store.id };

  // ===================================================================== ROLLBACK
  if (mode === "rollback") {
    const manifest = readJson(o.rollback, "manifest");
    const manifestPath = join(o.reportDir, `sku-link-rollback-${stamp}.json`);
    console.log(`ROLLBACK of manifest created ${manifest.createdAt} (plan ${manifest.planHash.slice(0, 12)}…), state ${manifest.state}`);
    const result = await rollbackSkuLink({ ...deps, manifest, onManifest: async (m) => writeAtomic(manifestPath, m) });
    console.log(JSON.stringify(result, null, 2));
    console.log(`updated manifest: ${manifestPath}`);
    process.exit(result.skipped.length ? 2 : 0);
  }

  // ===================================================================== PLAN / APPLY
  const preview = readJson(o.preview, "preview");
  const plan = await buildSkuLinkPlan({ ...deps, resolutions: o.resolutions });
  const problems = [...checkContract(plan, CONTRACT), ...diffAgainstPreview(plan, preview)];

  if (mode === "plan") {
    const planPath = join(o.reportDir, `sku-link-plan-${stamp}.json`);
    writeAtomic(planPath, { generatedAt: new Date().toISOString(), verdict: problems.length ? "REJECTED" : "MATCHES_PREVIEW", problems, hash: plan.hash, ...plan });
    console.log(`PLAN ONLY. Nothing was written to Shopify or the database.   shop=${plan.shop}`);
    console.log(`plan hash: ${plan.hash}`);
    console.log("\n== totals");
    console.table(plan.totals);
    console.log(`== contract + saved preview: ${problems.length ? "REJECTED" : "ALL CHECKS MATCH"}`);
    for (const p of problems) console.log(`   - ${p}`);
    console.log("== held back");
    console.table(plan.heldBack);
    console.log("== manual resolutions");
    console.table(plan.entries.filter((e) => e.manual).map((e) => ({ sku: e.sku, productId: e.productId })));
    console.log(`== first 8 of ${plan.totals.policyWrites} policy writes (all in the plan file)`);
    console.table(plan.entries.filter((e) => e.willWritePolicy).slice(0, 8).map((e) => ({ sku: e.sku, productId: e.productId, reason: e.policyStatus, revision: e.profileRevision, override: e.overrideAction })));
    console.log(`\nplan file: ${planPath}`);
    process.exit(problems.length ? 2 : 0);
  }

  // APPLY
  const approved = readJson(o.plan, "approved plan");
  if (approved.verdict !== "MATCHES_PREVIEW") fail("the approved plan file is not a MATCHES_PREVIEW plan");
  if (approved.shop !== o.shop || approved.storeId !== store.id) fail("the approved plan is for a different shop or store");
  if (problems.length) fail(`the live plan no longer satisfies the contract/preview: ${problems.join("; ")}`);

  const manifestPath = join(o.reportDir, `sku-link-manifest-${stamp}.json`);
  console.log(`APPLY  shop=${o.shop}  approved plan ${approved.hash.slice(0, 12)}…  live plan ${plan.hash.slice(0, 12)}…`);
  const result = await applySkuLinkPlan({ ...deps, resolutions: o.resolutions, approvedHash: approved.hash, onManifest: async (m) => writeAtomic(manifestPath, m) });
  console.log(`result: ${result.state}   policies written: ${result.policiesWritten}   overrides created: ${result.overridesCreated}`);
  for (const r of result.refusedBecause ?? []) console.log(`   refused: ${r}`);
  for (const r of result.abortedBecause ?? []) console.log(`   stopped: ${r}`);
  if (result.manifest) console.log(`manifest (written before the first mutation, updated per batch): ${manifestPath}`);
  process.exit(result.state === "completed" ? 0 : 2);
} catch (error) {
  const text = String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/gi, "<url>").replace(/shp[a-z]{2}_[A-Za-z0-9]+/g, "<token>");
  console.error(`ERROR: ${text.slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
