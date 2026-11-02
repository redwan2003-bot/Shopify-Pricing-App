#!/usr/bin/env node
/**
 * Guarded narrowing of a pilot to a chosen set of products, by editing every OTHER linked
 * product's app-owned `pricing_policy` metafield. Three modes:
 *
 *   PLAN (default, writes NOTHING)
 *     node --env-file=.env scripts/pilot-scope.mjs --keep 8438071820427 --report-dir <abs-dir>
 *     Reads every linked product's live policy metafield and lists exactly what would change.
 *
 *   APPLY
 *     PILOT_SCOPE_ALLOW_WRITE=1 node --env-file=.env scripts/pilot-scope.mjs --apply \
 *       --keep 8438071820427 --confirm-store <shop> --approved-plan <plan.json> --report-dir <abs-dir>
 *     Refuses while shop enforcement is enabled, and unless the rebuilt plan hashes to the
 *     approved one. Writes a manifest first, then edits the metafields compare-and-set in
 *     batches, verifying each batch, stopping at the first conflict.
 *
 *   ROLLBACK
 *     PILOT_SCOPE_ALLOW_WRITE=1 node --env-file=.env scripts/pilot-scope.mjs \
 *       --rollback <manifest.json> --confirm-store <shop> --report-dir <abs-dir>
 *
 *   --mode inactive    (default) sets active:false. Under `pilot` mode the product is then
 *                      BLOCKED at checkout (fail-closed).
 *   --mode unrequired  sets required:false. The product is simply not enforced (native price).
 *
 * The only mutation this client can send is `metafieldsSet`, and only in apply/rollback.
 * Nothing in the database is written. The offline token is used in memory, never printed.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { METAFIELDS_SET_MUTATION } from "../app/lib/catalog/admin-client.ts";
import { createAdminWritePort } from "../app/lib/catalog/write-port.ts";
import { applyScopePlan, buildScopePlan, checkScopeContract, rollbackScope } from "../app/lib/catalog/pilot-scope.ts";

const API_VERSION = "2026-07";

/** The reviewed contract: one product stays enforced, the other 144 are narrowed out. */
const CONTRACT = { change: 144, keep: ["gid://shopify/Product/8438071820427"], blocked: 0 };

const SHOP_POLICY_QUERY = `query ImprintIdShopEnforcementPolicy { shop { metafield(namespace: "$app:imprintid", key: "enforcement_policy") { jsonValue } } }`;

function fail(message) {
  console.error(`\nABORT: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const o = { shop: "imprintid-pricing-dev.myshopify.com", reportDir: null, apply: false, rollback: null, confirm: null, plan: null, keep: [], mode: "inactive" };
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
  else if (flag === "--rollback") o.rollback = value();
  else if (flag === "--keep") o.keep.push(value());
  else if (flag === "--mode") o.mode = value();
  else fail(`unknown argument: ${a}`);
}

const mode = o.rollback ? "rollback" : o.apply ? "apply" : "plan";
if (!["inactive", "unrequired"].includes(o.mode)) fail("--mode must be inactive or unrequired");
if (!o.reportDir || !isAbsolute(o.reportDir) || !existsSync(o.reportDir) || !statSync(o.reportDir).isDirectory()) fail("--report-dir must be an absolute path to an existing directory");
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (run with --env-file=.env)");
if (mode !== "rollback" && o.keep.length === 0) fail("--keep <productId> is required (the product(s) that stay enforced)");
if (mode !== "plan") {
  if (process.env.PILOT_SCOPE_ALLOW_WRITE !== "1") fail("writes require PILOT_SCOPE_ALLOW_WRITE=1");
  if (o.confirm !== o.shop) fail(`writes require --confirm-store ${o.shop}`);
}
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
  const deps = { prisma, storeId: store.id, shop: o.shop, keep: o.keep, mode: o.mode };

  const session = await prisma.session.findFirst({ where: { shop: o.shop, isOnline: false }, orderBy: { expires: "desc" } });
  if (!session?.accessToken) fail("no offline session for this shop; open the app in the Shopify Admin first");
  const needMs = mode === "plan" ? 3 * 60_000 : 15 * 60_000;
  if (session.expires && session.expires.getTime() < Date.now() + needMs) {
    fail(`the stored offline token expires at ${session.expires.toISOString()}, too soon for this run; load the app once in the Shopify Admin to refresh it`);
  }
  const token = session.accessToken;

  const allowedMutations = mode === "plan" ? [] : [METAFIELDS_SET_MUTATION];
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
  const port = createAdminWritePort(admin);
  const readShopPolicyJson = async () => {
    const res = await admin.graphql(SHOP_POLICY_QUERY);
    const body = await res.json();
    if (!body?.data?.shop) throw new Error("could not read the shop enforcement policy");
    return body.data.shop.metafield?.jsonValue ?? null;
  };

  if (mode === "rollback") {
    const manifest = readJson(o.rollback, "manifest");
    const manifestPath = join(o.reportDir, `pilot-scope-rollback-${stamp}.json`);
    console.log(`ROLLBACK of manifest created ${manifest.createdAt} (plan ${manifest.planHash.slice(0, 12)}…), state ${manifest.state}`);
    const result = await rollbackScope({ port, storeId: store.id, shop: o.shop, manifest, onManifest: async (m) => writeAtomic(manifestPath, m) });
    console.log(JSON.stringify(result, null, 2));
    console.log(`updated manifest: ${manifestPath}`);
    process.exit(result.skipped.length ? 2 : 0);
  }

  if (mode === "plan") {
    const plan = await buildScopePlan({ ...deps, port, shopPolicyJson: await readShopPolicyJson() });
    const problems = checkScopeContract(plan, CONTRACT);
    const planPath = join(o.reportDir, `pilot-scope-plan-${stamp}.json`);
    writeAtomic(planPath, { generatedAt: new Date().toISOString(), verdict: problems.length ? "REJECTED" : "MATCHES_CONTRACT", problems, ...plan });
    console.log(`PLAN ONLY. Nothing was written to Shopify or the database.   shop=${plan.shop}   mode=${plan.mode}`);
    console.log(`plan hash: ${plan.hash}`);
    console.log("\n== shop enforcement policy");
    console.log(JSON.stringify(plan.enforcement, null, 2));
    console.log("\n== totals");
    console.log(JSON.stringify(plan.totals, null, 2));
    console.log(`== contract: ${problems.length ? "REJECTED" : "ALL CHECKS MATCH"}`);
    for (const p of problems) console.log(`   - ${p}`);
    if (plan.enforcement.applyBlocked) console.log(`\n!! APPLY IS BLOCKED: ${plan.enforcement.reason}`);
    console.log("\n== kept (stays active and required)");
    for (const k of plan.kept) console.log(`${k.productGid} | digest ${k.liveDigest} | ${k.json}`);
    if (plan.blocked.length) {
      console.log("\n== blocked");
      for (const b of plan.blocked) console.log(`${b.productGid} | ${b.reason}`);
    }
    console.log("\n== every change (productGid | profile r<rev> | live digest -> field change)");
    const field = plan.mode === "inactive" ? "active true -> false" : "required true -> false";
    for (const r of plan.rows) console.log(`${r.productGid} | ${r.profileId} r${r.profileRevision} | ${r.liveDigest} | ${field}`);
    console.log(`\nplan file: ${planPath}`);
    process.exit(problems.length ? 2 : 0);
  }

  // APPLY
  const approved = readJson(o.plan, "approved plan");
  if (approved.verdict !== "MATCHES_CONTRACT") fail("the approved plan file was not a MATCHES_CONTRACT plan");
  const manifestPath = join(o.reportDir, `pilot-scope-manifest-${stamp}.json`);
  const result = await applyScopePlan({ ...deps, port, approvedHash: approved.hash, readShopPolicyJson, onManifest: async (m) => writeAtomic(manifestPath, m) });
  if (result.state === "refused") fail(result.refusedBecause.join("; "));
  console.log(`state=${result.state} changed=${result.changed}`);
  if (result.abortedBecause) for (const r of result.abortedBecause) console.log(`   - ${r}`);
  console.log(`manifest: ${manifestPath}`);
  process.exit(result.state === "completed" ? 0 : 2);
} finally {
  await prisma.$disconnect();
}
