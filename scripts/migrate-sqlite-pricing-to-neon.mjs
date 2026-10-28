#!/usr/bin/env node
/**
 * ONE-TIME migration: the real ImprintID development-store pricing data, from the preserved
 * `prisma/dev.sqlite`, into the Neon database named by DATABASE_URL.
 *
 *   node --env-file=.env scripts/migrate-sqlite-pricing-to-neon.mjs --report-dir <absolute-dir>                (dry-run, default, read-only)
 *   node --env-file=.env scripts/migrate-sqlite-pricing-to-neon.mjs --report-dir <absolute-dir> --apply --confirm-store=<shop>
 *   node --env-file=.env scripts/migrate-sqlite-pricing-to-neon.mjs --report-dir <absolute-dir> --rollback=<manifest.json> --confirm-store=<shop>
 *
 * --report-dir is REQUIRED: an absolute path to an EXISTING directory where reports and the
 * insert manifest are written. It is validated before either database is opened.
 *
 * WRITES ARE LOCKED TO THE REHEARSAL BRANCH. --apply and --rollback refuse to run unless
 * NEON_BRANCH is exactly WRITE_ALLOWED_BRANCH and the connection host contains
 * WRITE_ALLOWED_ENDPOINT (both constants below, naming the `pre-pricing-migration-20261028`
 * snapshot branch). Applying to production requires a deliberate, reviewed change to those
 * two constants; do not edit them casually.
 *
 * Safeguards
 *  - Dry-run is the default and writes nothing to the database.
 *  - Source is opened read-only. Only the one mapped source store is read; other stores
 *    (preview-harness, the old "-development" store) are never touched.
 *  - Only `storeId` is remapped (source Store id -> existing target Store id). Profile and
 *    child ids are preserved. Sessions and the Store row itself are never migrated.
 *  - Inserts are insert-only (never update/overwrite). A row that already exists with the
 *    same id but different content, or a natural-key clash (same sku / product id under a
 *    different id), blocks --apply.
 *  - --apply / --rollback additionally require MIGRATION_ALLOW_WRITE=1 and
 *    --confirm-store equal to the shop domain.
 *  - Inserted ids are written to a manifest per table BEFORE any insert; rollback deletes
 *    exactly those ids, children first, in bounded batches (no reliance on cascades).
 */

import { DatabaseSync } from "node:sqlite";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// ---------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------

// Flags that take a value may be written `--flag=value` or `--flag value`.
const VALUE_FLAGS = new Set(["source", "shop", "report-dir", "connection-env", "confirm-store", "rollback"]);
const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, ...v] = a.slice(2).split("=");
    if (v.length) args[k] = v.join("=");
    else if (VALUE_FLAGS.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[k] = argv[++i];
    else args[k] = true;
  }
}

function fail(message) {
  console.error(`\nABORT: ${message}`);
  process.exit(1);
}

const SOURCE_PATH = args.source ?? "prisma/dev.sqlite";
const SHOP = args.shop ?? "imprintid-pricing-dev.myshopify.com";
const REPORT_DIR = args["report-dir"];
if (typeof REPORT_DIR !== "string" || REPORT_DIR.length === 0) {
  fail("--report-dir <absolute-path> is required (an existing directory for reports and the insert manifest)");
}
if (!isAbsolute(REPORT_DIR)) fail(`--report-dir must be an absolute path (got "${REPORT_DIR}")`);
if (!existsSync(REPORT_DIR) || !statSync(REPORT_DIR).isDirectory()) {
  fail(`--report-dir "${REPORT_DIR}" does not exist or is not a directory; create it first`);
}
const CONNECTION_ENV = args["connection-env"] ?? "DATABASE_URL";
const APPLY = args.apply === true;
const ROLLBACK = typeof args.rollback === "string" ? args.rollback : null;
const WRITE_MODE = APPLY || ROLLBACK !== null;
const CHUNK = 500;
const WRITE_ALLOWED_BRANCH = "pre-pricing-migration-20261028";
const WRITE_ALLOWED_ENDPOINT = "ep-quiet-scene-b48dys1c";

// Excluded on purpose: never read as a source, listed so the report states it.
const EXCLUDED_SOURCE_SHOPS = ["preview-harness.myshopify.com", "imprintid-pricing-development.myshopify.com"];

// Dependency order (parents first). `where` selects rows owned by the one source store.
const OWNED_PROFILES = "select id from PricingProfile where storeId = ?";
const TABLES = [
  { model: "PricingProfile", delegate: "pricingProfile", where: "storeId = ?", remapStore: true },
  { model: "QuantityTier", delegate: "quantityTier", where: `pricingProfileId in (${OWNED_PROFILES})` },
  { model: "DecorationRule", delegate: "decorationRule", where: `pricingProfileId in (${OWNED_PROFILES})` },
  { model: "DecorationColorCharge", delegate: "decorationColorCharge", where: `pricingProfileId in (${OWNED_PROFILES})` },
  { model: "OptionGroup", delegate: "optionGroup", where: `pricingProfileId in (${OWNED_PROFILES})` },
  {
    model: "OptionValue",
    delegate: "optionValue",
    where: `optionGroupId in (select g.id from OptionGroup g join PricingProfile p on p.id = g.pricingProfileId where p.storeId = ?)`,
  },
  { model: "ProductColor", delegate: "productColor", where: `pricingProfileId in (${OWNED_PROFILES})` },
  { model: "ProductionRule", delegate: "productionRule", where: `pricingProfileId in (${OWNED_PROFILES})` },
  { model: "PackagingRule", delegate: "packagingRule", where: `pricingProfileId in (${OWNED_PROFILES})` },
  { model: "ProductPricingOverride", delegate: "productPricingOverride", where: "storeId = ?", remapStore: true },
];

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const fieldsByModel = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [m.name, m.fields.filter((f) => f.kind !== "object")]),
);

/** SQLite value -> the JS value Prisma expects for this field's type. */
function convert(field, value) {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case "Boolean":
      return value === 1 || value === 1n || value === true || value === "1";
    case "DateTime":
      return typeof value === "number" || typeof value === "bigint" ? new Date(Number(value)) : new Date(value);
    case "Int":
    case "Float":
      return Number(value);
    case "BigInt":
      return BigInt(value);
    case "Json":
      return typeof value === "string" ? JSON.parse(value) : value;
    default:
      return value; // String and enums are stored as text
  }
}

function toPrismaRow(model, raw, columns, storeIdMap) {
  const out = {};
  for (const f of fieldsByModel.get(model)) {
    if (!columns.has(f.name)) {
      if (f.isRequired && !f.hasDefaultValue) fail(`${model}.${f.name} is required but missing from the SQLite source`);
      continue;
    }
    out[f.name] = convert(f, raw[f.name]);
  }
  if (storeIdMap && out.storeId !== undefined) {
    if (out.storeId !== storeIdMap.from) fail(`${model} row ${out.id} belongs to an unexpected store`);
    out.storeId = storeIdMap.to;
  }
  return out;
}

/** Stable representation for equality checks between a source row and a target row. */
function canonical(row) {
  const keys = Object.keys(row).sort();
  const o = {};
  for (const k of keys) {
    const v = row[k];
    o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : v;
  }
  return JSON.stringify(o);
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function targetHost(url) {
  const m = /@([^/:?]+)/.exec(url);
  return m ? m[1] : "(unknown)";
}

// ---------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------

const connectionString = process.env[CONNECTION_ENV];
if (!connectionString) fail(`${CONNECTION_ENV} is not set (run with --env-file=.env)`);

if (WRITE_MODE) {
  if (process.env.MIGRATION_ALLOW_WRITE !== "1") fail("writes require MIGRATION_ALLOW_WRITE=1");
  if (args["confirm-store"] !== SHOP) fail(`writes require --confirm-store=${SHOP}`);
  // Rehearsal-only guard: writes are refused anywhere except the pre-migration snapshot
  // branch. Production apply requires a deliberate, reviewed change to these constants.
  if (process.env.NEON_BRANCH !== WRITE_ALLOWED_BRANCH) {
    fail(`writes are only allowed when NEON_BRANCH is exactly "${WRITE_ALLOWED_BRANCH}" (got "${process.env.NEON_BRANCH ?? ""}")`);
  }
  if (!targetHost(connectionString).includes(WRITE_ALLOWED_ENDPOINT)) {
    fail(`writes are only allowed against endpoint ${WRITE_ALLOWED_ENDPOINT}; the connection points elsewhere`);
  }
}

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, "-");

try {
  const targetStore = await prisma.store.findUnique({ where: { shopDomain: SHOP } });
  if (!targetStore) fail(`target database has no Store row for ${SHOP}`);

  // ---- rollback mode ---------------------------------------------------------------
  if (ROLLBACK) {
    const manifestRaw = readFileSync(ROLLBACK, "utf8");
    const manifest = JSON.parse(manifestRaw);
    if (manifest.shop !== SHOP || manifest.targetStoreId !== targetStore.id) fail("manifest does not match this shop/store");
    const manifestSha256 = sha256(JSON.stringify(manifest)); // same digest the apply printed
    console.log(`ROLLBACK from ${ROLLBACK} (sha256 ${manifestSha256}) on host ${targetHost(connectionString)}`);
    const ownedWhere = {
      PricingProfile: { storeId: targetStore.id },
      ProductPricingOverride: { storeId: targetStore.id },
      OptionValue: { optionGroup: { pricingProfile: { storeId: targetStore.id } } },
    };
    const rollbackRows = [];
    for (const t of [...TABLES].reverse()) {
      const ids = manifest.tables[t.model] ?? [];
      let deleted = 0;
      for (const batch of chunks(ids, CHUNK)) {
        deleted += (await prisma[t.delegate].deleteMany({ where: { id: { in: batch } } })).count;
      }
      let remainingFromManifest = 0;
      for (const batch of chunks(ids, 1000)) remainingFromManifest += await prisma[t.delegate].count({ where: { id: { in: batch } } });
      const ownedNow = await prisma[t.delegate].count({ where: ownedWhere[t.model] ?? { pricingProfile: { storeId: targetStore.id } } });
      rollbackRows.push({ table: t.model, manifest: ids.length, deleted, remainingFromManifest, ownedByStoreNow: ownedNow });
    }
    console.table(rollbackRows);
    const allZero = rollbackRows.every((r) => r.deleted <= r.manifest && r.remainingFromManifest === 0 && r.ownedByStoreNow === 0);
    const rollbackReport = {
      mode: "rollback",
      startedAt,
      manifestPath: ROLLBACK,
      manifestSha256,
      target: { host: targetHost(connectionString), shop: SHOP, storeId: targetStore.id },
      tables: rollbackRows,
      allImportedTablesZero: allZero,
    };
    const rollbackPath = join(REPORT_DIR, `pricing-migration-rollback-${stamp}.json`);
    writeFileSync(rollbackPath, JSON.stringify(rollbackReport, null, 2));
    console.log(`report: ${rollbackPath}`);
    console.log(allZero ? "Rollback complete: all ten imported tables are at zero for the target store." : "ROLLBACK INCOMPLETE: see table above.");
    await prisma.$disconnect();
    process.exit(allZero ? 0 : 2);
  }

  // ---- read the one source store ----------------------------------------------------
  if (!existsSync(SOURCE_PATH)) fail(`source not found: ${SOURCE_PATH}`);
  const source = new DatabaseSync(SOURCE_PATH, { readOnly: true });
  const srcStore = source.prepare("select id, shopDomain from Store where shopDomain = ?").get(SHOP);
  if (!srcStore) fail(`source has no Store row for ${SHOP}`);
  if (EXCLUDED_SOURCE_SHOPS.includes(SHOP)) fail(`${SHOP} is an excluded fixture store`);
  const storeIdMap = { from: srcStore.id, to: targetStore.id };

  const plan = [];
  for (const t of TABLES) {
    const param = t.where.includes("?") ? Array(t.where.split("?").length - 1).fill(srcStore.id) : [];
    const stmt = source.prepare(`select * from "${t.model}" where ${t.where} order by id`);
    const rawRows = stmt.all(...param);
    const columns = new Set(source.prepare(`pragma table_info("${t.model}")`).all().map((c) => c.name));
    plan.push({ ...t, rows: rawRows.map((r) => toPrismaRow(t.model, r, columns, t.remapStore ? storeIdMap : null)) });
  }
  source.close();

  // Foreign-key closure inside the migrated set.
  const ids = (model) => new Set(plan.find((p) => p.model === model).rows.map((r) => r.id));
  const profileIds = ids("PricingProfile");
  const groupIds = ids("OptionGroup");
  const closureProblems = [];
  for (const p of plan) {
    for (const r of p.rows) {
      if (r.pricingProfileId && !profileIds.has(r.pricingProfileId)) closureProblems.push(`${p.model} ${r.id} -> missing profile ${r.pricingProfileId}`);
      if (r.optionGroupId && !groupIds.has(r.optionGroupId)) closureProblems.push(`${p.model} ${r.id} -> missing option group ${r.optionGroupId}`);
    }
  }

  // ---- compare with the target ------------------------------------------------------
  const report = [];
  const toInsert = {};
  const different = [];
  for (const p of plan) {
    const existing = new Map();
    for (const batch of chunks(p.rows.map((r) => r.id), 1000)) {
      for (const row of await prisma[p.delegate].findMany({ where: { id: { in: batch } } })) existing.set(row.id, row);
    }
    let same = 0;
    const insert = [];
    for (const r of p.rows) {
      const e = existing.get(r.id);
      if (!e) insert.push(r);
      else if (canonical(r) === canonical(Object.fromEntries(Object.keys(r).map((k) => [k, e[k]])))) same++;
      else different.push(`${p.model} ${r.id}`);
    }
    toInsert[p.model] = insert;
    report.push({ table: p.model, source: p.rows.length, alreadyPresentSame: same, alreadyPresentDifferent: existing.size - same, wouldInsert: insert.length });
  }

  // Natural-key clashes under a different id.
  const clashes = [];
  const srcProfiles = plan.find((p) => p.model === "PricingProfile").rows;
  const tgtProfiles = await prisma.pricingProfile.findMany({ where: { storeId: targetStore.id }, select: { id: true, sku: true } });
  for (const t of tgtProfiles) {
    const s = srcProfiles.find((r) => r.sku === t.sku);
    if (s && s.id !== t.id) clashes.push(`PricingProfile sku ${t.sku}: target id ${t.id} != source id ${s.id}`);
  }
  const srcOverrides = plan.find((p) => p.model === "ProductPricingOverride").rows;
  const tgtOverrides = await prisma.productPricingOverride.findMany({ where: { storeId: targetStore.id }, select: { id: true, shopifyProductId: true } });
  for (const t of tgtOverrides) {
    const s = srcOverrides.find((r) => r.shopifyProductId === t.shopifyProductId);
    if (s && s.id !== t.id) clashes.push(`ProductPricingOverride product ${t.shopifyProductId}: target id ${t.id} != source id ${s.id}`);
  }

  const targetProfilesTotal = tgtProfiles.length;
  const blockers = [...closureProblems, ...clashes, ...different.map((d) => `differs from target: ${d}`)];

  // ---- report -----------------------------------------------------------------------
  const out = {
    mode: APPLY ? "apply" : "dry-run",
    startedAt,
    source: { path: SOURCE_PATH, shop: SHOP, storeId: srcStore.id },
    target: { host: targetHost(connectionString), shop: SHOP, storeId: targetStore.id, shopCurrency: targetStore.shopCurrency },
    excludedSourceShops: EXCLUDED_SOURCE_SHOPS,
    targetPricingProfilesBefore: targetProfilesTotal,
    tables: report,
    blockers,
  };
  console.log(`\n${out.mode.toUpperCase()}  source=${SOURCE_PATH}  target-host=${out.target.host}`);
  console.log(`shop ${SHOP}: source store ${srcStore.id} -> target store ${targetStore.id} (shopCurrency stays ${targetStore.shopCurrency ?? "null"}; not touched)`);
  console.log(`excluded source shops: ${EXCLUDED_SOURCE_SHOPS.join(", ")}`);
  console.table(report);
  console.log(blockers.length ? `BLOCKERS (${blockers.length}):\n  ${blockers.slice(0, 20).join("\n  ")}` : "No blockers.");

  const reportPath = join(REPORT_DIR, `pricing-migration-${out.mode}-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify(out, null, 2));
  console.log(`report: ${reportPath}`);

  if (!APPLY) process.exit(blockers.length ? 2 : 0);

  // ---- apply ------------------------------------------------------------------------
  if (blockers.length) fail("blockers present; refusing to apply");
  const manifest = {
    startedAt,
    shop: SHOP,
    targetStoreId: targetStore.id,
    targetHost: out.target.host,
    tables: Object.fromEntries(Object.entries(toInsert).map(([m, rows]) => [m, rows.map((r) => r.id)])),
  };
  const manifestPath = join(REPORT_DIR, `pricing-migration-manifest-${stamp}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); // written BEFORE any insert
  console.log(`manifest (written before inserts): ${manifestPath}  sha256=${sha256(JSON.stringify(manifest))}`);

  for (const p of plan) {
    const rows = toInsert[p.model];
    let inserted = 0;
    for (const batch of chunks(rows, CHUNK)) {
      inserted += (await prisma[p.delegate].createMany({ data: batch, skipDuplicates: true })).count;
    }
    console.log(`  ${p.model.padEnd(24)} planned=${rows.length} inserted=${inserted}`);
    if (inserted !== rows.length) fail(`${p.model}: inserted ${inserted} of ${rows.length}; stop and review (use --rollback=${manifestPath})`);
  }

  // Reconcile: every migrated id is present, per table.
  let ok = true;
  for (const p of plan) {
    let present = 0;
    for (const batch of chunks(p.rows.map((r) => r.id), 1000)) present += await prisma[p.delegate].count({ where: { id: { in: batch } } });
    const match = present === p.rows.length;
    ok &&= match;
    console.log(`  reconcile ${p.model.padEnd(24)} source=${p.rows.length} target=${present} ${match ? "OK" : "MISMATCH"}`);
  }
  if (!ok) fail("reconciliation mismatch; review before continuing");
  console.log("\nApply complete and reconciled.");
} finally {
  await prisma.$disconnect();
}
