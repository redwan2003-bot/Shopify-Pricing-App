#!/usr/bin/env node
/**
 * Guarded processor-confirmed readiness stamping (policySyncedAt / policyDigest /
 * enforcementReady). Three modes:
 *
 *   PLAN (default, writes NOTHING to Shopify or the database)
 *     node --env-file=.env scripts/stamp-readiness.mjs --report-dir <abs-dir>
 *     Reads every active override, the live Shopify policy metafield for each product and the
 *     shop enforcement policy. Lists exactly which products the assignment processor would
 *     stamp, which cannot be, and whether apply is currently blocked by enabled enforcement.
 *
 *   APPLY
 *     STAMP_READINESS_ALLOW_WRITE=1 node --env-file=.env scripts/stamp-readiness.mjs --apply \
 *       --confirm-store <shop> --approved-plan <plan.json> --report-dir <abs-dir>
 *     Refuses while `enforcement_policy.enabled` is true, and unless the rebuilt plan hashes to
 *     the approved one. Writes a manifest first, then drives the assignment processor one
 *     product at a time, compare-and-set, stopping at the first conflict.
 *
 *   ROLLBACK
 *     STAMP_READINESS_ALLOW_WRITE=1 node --env-file=.env scripts/stamp-readiness.mjs \
 *       --rollback <manifest.json> --confirm-store <shop> --report-dir <abs-dir>
 *     Restores the local before-values. Shopify is never touched.
 *
 * The Shopify client refuses EVERY GraphQL mutation in every mode: this runner only reads
 * Shopify. The offline token is used in memory and never printed.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createAdminWritePort } from "../app/lib/catalog/write-port.ts";
import { applyReadinessPlan, buildReadinessPlan, checkReadinessContract, rollbackReadiness } from "../app/lib/catalog/readiness-stamp.ts";

const API_VERSION = "2026-07";

/** The reviewed contract: every one of the 145 SKU-linked products is stampable, none blocked. */
const CONTRACT = { stamp: 145, alreadyReady: 0, blocked: 0 };

const SHOP_POLICY_QUERY = `query ImprintIdShopEnforcementPolicy { shop { metafield(namespace: "$app:imprintid", key: "enforcement_policy") { jsonValue } } }`;

function fail(message) {
  console.error(`\nABORT: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const o = { shop: "imprintid-pricing-dev.myshopify.com", reportDir: null, apply: false, rollback: null, confirm: null, plan: null };
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
  else fail(`unknown argument: ${a}`);
}

const mode = o.rollback ? "rollback" : o.apply ? "apply" : "plan";
if (!o.reportDir || !isAbsolute(o.reportDir) || !existsSync(o.reportDir) || !statSync(o.reportDir).isDirectory()) fail("--report-dir must be an absolute path to an existing directory");
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (run with --env-file=.env)");
if (mode !== "plan") {
  if (process.env.STAMP_READINESS_ALLOW_WRITE !== "1") fail("writes require STAMP_READINESS_ALLOW_WRITE=1");
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
  const deps = { prisma, storeId: store.id, shop: o.shop };

  if (mode === "rollback") {
    const manifest = readJson(o.rollback, "manifest");
    const manifestPath = join(o.reportDir, `readiness-rollback-${stamp}.json`);
    console.log(`ROLLBACK of manifest created ${manifest.createdAt} (plan ${manifest.planHash.slice(0, 12)}…), state ${manifest.state}`);
    const result = await rollbackReadiness({ ...deps, manifest, onManifest: async (m) => writeAtomic(manifestPath, m) });
    console.log(JSON.stringify(result, null, 2));
    console.log(`updated manifest: ${manifestPath}`);
    process.exit(result.skipped.length ? 2 : 0);
  }

  const session = await prisma.session.findFirst({ where: { shop: o.shop, isOnline: false }, orderBy: { expires: "desc" } });
  if (!session?.accessToken) fail("no offline session for this shop; open the app in the Shopify Admin first");
  // ~19 s per product over a high-latency link: 145 products need most of an hour of token life.
  const needMs = mode === "plan" ? 3 * 60_000 : 50 * 60_000;
  if (session.expires && session.expires.getTime() < Date.now() + needMs) {
    fail(`the stored offline token expires at ${session.expires.toISOString()}, too soon for this run; load the app once in the Shopify Admin to refresh it`);
  }
  const token = session.accessToken;

  const admin = {
    async graphql(query, options = {}) {
      if (/\bmutation\b/i.test(query)) throw new Error("refusing to send a GraphQL mutation: this runner only reads Shopify");
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

  if (mode === "plan") {
    const plan = await buildReadinessPlan({ ...deps, port, shopPolicyJson: await readShopPolicyJson() });
    const problems = checkReadinessContract(plan, CONTRACT);
    const planPath = join(o.reportDir, `readiness-plan-${stamp}.json`);
    writeAtomic(planPath, { generatedAt: new Date().toISOString(), verdict: problems.length ? "REJECTED" : "MATCHES_CONTRACT", problems, ...plan });
    console.log(`PLAN ONLY. Nothing was written to Shopify or the database.   shop=${plan.shop}`);
    console.log(`plan hash: ${plan.hash}`);
    console.log("\n== shop enforcement policy");
    console.log(JSON.stringify(plan.enforcement, null, 2));
    console.log("\n== totals");
    console.log(JSON.stringify(plan.totals, null, 2));
    console.log(`== contract: ${problems.length ? "REJECTED" : "ALL CHECKS MATCH"}`);
    for (const p of problems) console.log(`   - ${p}`);
    if (plan.enforcement.applyBlocked) console.log(`\n!! APPLY IS BLOCKED: ${plan.enforcement.reason}`);
    if (plan.blocked.length) {
      console.log("\n== blocked rows");
      for (const b of plan.blocked) console.log(`${b.productGid} | ${b.reason}`);
    }
    console.log("\n== every stampable row (productGid | profileId r<revision> | live digest | columns that would change)");
    for (const r of plan.rows) {
      console.log(`${r.productGid} | ${r.profileId} r${r.profileRevision} | ${r.liveDigest} | policySyncedAt ${r.before.policySyncedAt} -> now; policyDigest ${r.before.policyDigest} -> live digest; enforcementReady ${r.before.enforcementReady} -> true`);
    }
    console.log(`\nplan file: ${planPath}`);
    process.exit(problems.length ? 2 : 0);
  }

  // APPLY
  const approved = readJson(o.plan, "approved plan");
  if (approved.verdict !== "MATCHES_CONTRACT") fail("the approved plan file was not a MATCHES_CONTRACT plan");
  const manifestPath = join(o.reportDir, `readiness-manifest-${stamp}.json`);
  const result = await applyReadinessPlan({ ...deps, port, approvedHash: approved.hash, readShopPolicyJson, onManifest: async (m) => writeAtomic(manifestPath, m) });
  if (result.state === "refused") fail(result.refusedBecause.join("; "));
  console.log(`state=${result.state} stamped=${result.stamped}`);
  if (result.abortedBecause) for (const r of result.abortedBecause) console.log(`   - ${r}`);
  console.log(`manifest: ${manifestPath}`);
  process.exit(result.state === "completed" ? 0 : 2);
} finally {
  await prisma.$disconnect();
}
