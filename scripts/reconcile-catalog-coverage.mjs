#!/usr/bin/env node
/**
 * Guarded one-off reconciliation of the catalog coverage columns. Three modes:
 *
 *   PLAN (default, writes NOTHING)
 *     node --env-file=.env scripts/reconcile-catalog-coverage.mjs --report-dir <abs-dir>
 *     Computes exactly which CatalogProduct rows would change and how, checks the plan against
 *     the reviewed contract, and writes a plan file whose hash a human approves.
 *
 *   APPLY
 *     COVERAGE_RECONCILE_ALLOW_WRITE=1 node --env-file=.env scripts/reconcile-catalog-coverage.mjs \
 *       --apply --confirm-store <shop> --approved-plan <plan.json> --report-dir <abs-dir>
 *     Refuses unless the freshly rebuilt plan hashes to the approved one. Writes a manifest with
 *     every row's before-values BEFORE the first update, then updates compare-and-set.
 *
 *   ROLLBACK
 *     COVERAGE_RECONCILE_ALLOW_WRITE=1 node --env-file=.env scripts/reconcile-catalog-coverage.mjs \
 *       --rollback <manifest.json> --confirm-store <shop> --report-dir <abs-dir>
 *
 * Only assignedProfileId, assignmentSource, coverageStatus and enforcementReady can change.
 * policySyncedAt and policyDigest are never read for writing; a plan that would alter
 * enforcementReady is rejected. Nothing here talks to Shopify.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { applyCoveragePlan, buildCoveragePlan, checkCoverageContract, rollbackCoveragePlan } from "../app/lib/catalog/coverage-plan.ts";

/** The reviewed contract: one row per live override, all moving from unassigned to assigned. */
const CONTRACT = { changes: 145, transition: "unassigned->assigned" };

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
  if (process.env.COVERAGE_RECONCILE_ALLOW_WRITE !== "1") fail("writes require COVERAGE_RECONCILE_ALLOW_WRITE=1");
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
    const manifestPath = join(o.reportDir, `coverage-rollback-${stamp}.json`);
    console.log(`ROLLBACK of manifest created ${manifest.createdAt} (plan ${manifest.planHash.slice(0, 12)}…), state ${manifest.state}`);
    const result = await rollbackCoveragePlan({ ...deps, manifest, onManifest: async (m) => writeAtomic(manifestPath, m) });
    console.log(JSON.stringify(result, null, 2));
    console.log(`updated manifest: ${manifestPath}`);
    process.exit(result.skipped.length ? 2 : 0);
  }

  const plan = await buildCoveragePlan(prisma, store.id, o.shop);
  const problems = checkCoverageContract(plan, CONTRACT);

  if (mode === "plan") {
    const planPath = join(o.reportDir, `coverage-plan-${stamp}.json`);
    writeAtomic(planPath, { generatedAt: new Date().toISOString(), verdict: problems.length ? "REJECTED" : "MATCHES_CONTRACT", problems, ...plan });
    console.log(`PLAN ONLY. Nothing was written.   shop=${plan.shop}   scanned=${plan.scanned}`);
    console.log(`plan hash: ${plan.hash}`);
    console.log("\n== totals");
    console.log(JSON.stringify(plan.totals, null, 2));
    console.log(`== contract: ${problems.length ? "REJECTED" : "ALL CHECKS MATCH"}`);
    for (const p of problems) console.log(`   - ${p}`);
    console.log("\n== every row (productGid | before -> after)");
    for (const c of plan.changes) {
      const diff = Object.keys(c.after)
        .filter((k) => c.before[k] !== c.after[k])
        .map((k) => `${k}: ${JSON.stringify(c.before[k])} -> ${JSON.stringify(c.after[k])}`)
        .join("; ");
      console.log(`${c.productGid} | ${diff}`);
    }
    console.log(`\nplan file: ${planPath}`);
    process.exit(problems.length ? 2 : 0);
  }

  // APPLY
  if (problems.length) fail(`the live plan breaks the contract: ${problems.join("; ")}`);
  const approved = readJson(o.plan, "approved plan");
  if (approved.verdict !== "MATCHES_CONTRACT") fail("the approved plan file was not a MATCHES_CONTRACT plan");
  const manifestPath = join(o.reportDir, `coverage-manifest-${stamp}.json`);
  const result = await applyCoveragePlan({ ...deps, approvedHash: approved.hash, onManifest: async (m) => writeAtomic(manifestPath, m) });
  if (result.refusedBecause) fail(result.refusedBecause.join("; "));
  console.log(`state=${result.state} updated=${result.updated}`);
  if (result.abortedBecause) for (const r of result.abortedBecause) console.log(`   - ${r}`);
  console.log(`manifest: ${manifestPath}`);
  process.exit(result.state === "completed" ? 0 : 2);
} finally {
  await prisma.$disconnect();
}
