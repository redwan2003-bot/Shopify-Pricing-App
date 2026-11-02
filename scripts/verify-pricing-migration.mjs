#!/usr/bin/env node
/**
 * READ-ONLY verification of the SQLite -> Neon pricing migration. Writes nothing anywhere.
 *
 *   node --env-file=.env.rehearsal scripts/verify-pricing-migration.mjs
 *
 * 1. Reconciliation hash: for each of the ten migrated tables, a SHA-256 over the ordered
 *    canonical records (id + every scalar column) of the source store's rows in SQLite,
 *    after the storeId remap, against the same rows in the target database.
 * 2. Pricing smoke test: the REAL loadPricingContext + calculatePricingFromProfile run on
 *    SQLite data (through a minimal read-only Prisma shim) and on the target database, over
 *    a deterministic grid of cases, compared to the cent.
 */

import { DatabaseSync } from "node:sqlite";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { loadPricingContext, calculatePricingFromProfile } from "../app/lib/pricing/index.ts";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
const SOURCE_PATH = args.source ?? "prisma/dev.sqlite";
const SHOP = args.shop ?? "imprintid-pricing-dev.myshopify.com";
const OVERRIDE_PRODUCT = args["override-product"] ?? "8438071820427";
const OVERRIDE_SKU = args["override-sku"] ?? "LNY01";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) { console.error("DATABASE_URL not set (use --env-file)"); process.exit(1); }
if (!existsSync(SOURCE_PATH)) { console.error(`source not found: ${SOURCE_PATH}`); process.exit(1); }

const OWNED = "select id from PricingProfile where storeId = ?";
const TABLES = [
  { model: "PricingProfile", delegate: "pricingProfile", where: "storeId = ?", remap: true, targetWhere: (s) => ({ storeId: s }) },
  { model: "QuantityTier", delegate: "quantityTier", where: `pricingProfileId in (${OWNED})`, targetWhere: (s) => ({ pricingProfile: { storeId: s } }) },
  { model: "DecorationRule", delegate: "decorationRule", where: `pricingProfileId in (${OWNED})`, targetWhere: (s) => ({ pricingProfile: { storeId: s } }) },
  { model: "DecorationColorCharge", delegate: "decorationColorCharge", where: `pricingProfileId in (${OWNED})`, targetWhere: (s) => ({ pricingProfile: { storeId: s } }) },
  { model: "OptionGroup", delegate: "optionGroup", where: `pricingProfileId in (${OWNED})`, targetWhere: (s) => ({ pricingProfile: { storeId: s } }) },
  { model: "OptionValue", delegate: "optionValue", where: `optionGroupId in (select g.id from OptionGroup g join PricingProfile p on p.id = g.pricingProfileId where p.storeId = ?)`, targetWhere: (s) => ({ optionGroup: { pricingProfile: { storeId: s } } }) },
  { model: "ProductColor", delegate: "productColor", where: `pricingProfileId in (${OWNED})`, targetWhere: (s) => ({ pricingProfile: { storeId: s } }) },
  { model: "ProductionRule", delegate: "productionRule", where: `pricingProfileId in (${OWNED})`, targetWhere: (s) => ({ pricingProfile: { storeId: s } }) },
  { model: "PackagingRule", delegate: "packagingRule", where: `pricingProfileId in (${OWNED})`, targetWhere: (s) => ({ pricingProfile: { storeId: s } }) },
  { model: "ProductPricingOverride", delegate: "productPricingOverride", where: "storeId = ?", remap: true, targetWhere: (s) => ({ storeId: s }) },
];

const fieldsByModel = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m.fields.filter((f) => f.kind !== "object")]));

function convert(field, v) {
  if (v === null || v === undefined) return null;
  switch (field.type) {
    case "Boolean": return v === 1 || v === 1n || v === true || v === "1";
    case "DateTime": return typeof v === "number" || typeof v === "bigint" ? new Date(Number(v)) : new Date(v);
    case "Int": case "Float": return Number(v);
    case "BigInt": return BigInt(v);
    case "Json": return typeof v === "string" ? JSON.parse(v) : v;
    default: return v;
  }
}
function toRow(model, raw, columns, storeMap) {
  const out = {};
  for (const f of fieldsByModel.get(model)) if (columns.has(f.name)) out[f.name] = convert(f, raw[f.name]);
  if (storeMap && out.storeId !== undefined) out.storeId = storeMap.to;
  return out;
}
const canon = (row) => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map((k) => { const v = row[k]; return [k, v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : v]; })));
const sha = (list) => createHash("sha256").update(list.join("\n")).digest("hex");
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const source = new DatabaseSync(SOURCE_PATH, { readOnly: true });
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });
let failures = 0;

try {
  const srcStore = source.prepare("select * from Store where shopDomain = ?").get(SHOP);
  const tgtStore = await prisma.store.findUnique({ where: { shopDomain: SHOP } });
  if (!srcStore || !tgtStore) throw new Error("store missing on one side");
  const storeMap = { from: srcStore.id, to: tgtStore.id };
  console.log(`target host: ${/@([^/:?]+)/.exec(connectionString)?.[1]}   store ${srcStore.id} -> ${tgtStore.id}\n`);

  // ---------------------------------------------------------------- 1. reconciliation hash
  console.log("== 1. Reconciliation hash (ordered by id; all scalar columns; storeId remapped)");
  const rows = [];
  for (const t of TABLES) {
    const params = t.where.includes("?") ? Array(t.where.split("?").length - 1).fill(srcStore.id) : [];
    const cols = new Set(source.prepare(`pragma table_info("${t.model}")`).all().map((c) => c.name));
    const src = source.prepare(`select * from "${t.model}" where ${t.where} order by id`).all(...params).map((r) => toRow(t.model, r, cols, t.remap ? storeMap : null));
    const ids = src.map((r) => r.id);
    const tgtRows = [];
    for (const b of chunks(ids, 1000)) tgtRows.push(...(await prisma[t.delegate].findMany({ where: { id: { in: b } } })));
    tgtRows.sort((a, b) => (a.id < b.id ? -1 : 1));
    const srcHash = sha(src.map(canon));
    const tgtHash = sha(tgtRows.map((r) => canon(Object.fromEntries(Object.keys(src[0] ?? {}).map((k) => [k, r[k]])))));
    const ownedInTarget = await prisma[t.delegate].count({ where: t.targetWhere(tgtStore.id) });
    const ok = srcHash === tgtHash && src.length === tgtRows.length && ownedInTarget === src.length;
    if (!ok) failures++;
    rows.push({ table: t.model, source: src.length, target: tgtRows.length, ownedInTarget, hash: srcHash.slice(0, 16), match: ok ? "MATCH" : "DIFF" });
  }
  console.table(rows);

  // ---------------------------------------------------------------- 2. pricing smoke test
  console.log("== 2. Pricing smoke test (real loadPricingContext + calculatePricingFromProfile)");
  const q = (sql, ...p) => source.prepare(sql).all(...p);
  const cols = (m) => new Set(source.prepare(`pragma table_info("${m}")`).all().map((c) => c.name));
  const conv = (m, r) => toRow(m, r, cols(m), null);
  const shim = {
    store: { findUnique: async ({ where }) => { const r = source.prepare("select * from Store where shopDomain = ?").get(where.shopDomain); return r ? conv("Store", r) : null; } },
    productPricingOverride: {
      findFirst: async ({ where }) => {
        const ids = where.shopifyProductId.in;
        const r = source.prepare(`select * from ProductPricingOverride where storeId = ? and shopifyProductId in (${ids.map(() => "?").join(",")})`).get(where.storeId, ...ids);
        return r ? conv("ProductPricingOverride", r) : null;
      },
    },
    pricingProfile: {
      findUnique: async ({ where }) => {
        const raw = where.id ? source.prepare("select * from PricingProfile where id = ?").get(where.id)
          : source.prepare("select * from PricingProfile where storeId = ? and sku = ?").get(where.storeId_sku.storeId, where.storeId_sku.sku);
        if (!raw) return null;
        const p = conv("PricingProfile", raw);
        const kids = (m) => q(`select * from "${m}" where pricingProfileId = ?`, p.id).map((r) => conv(m, r));
        const groups = kids("OptionGroup").map((g) => ({ ...g, optionValues: q('select * from "OptionValue" where optionGroupId = ?', g.id).map((r) => conv("OptionValue", r)) }));
        return { ...p, quantityTiers: kids("QuantityTier"), decorationRules: kids("DecorationRule"), decorationColorCharges: kids("DecorationColorCharge"), optionGroups: groups, productColors: kids("ProductColor"), productionRules: kids("ProductionRule"), packagingRules: kids("PackagingRule") };
      },
    },
  };

  const sourceSkus = q("select sku from PricingProfile where storeId = ? order by sku", srcStore.id).map((r) => r.sku);
  const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
  const run = (profile, source_, input) => { try { const r = calculatePricingFromProfile(profile, source_, input); const { source: _s, ...rest } = r; return { ok: rest }; } catch (e) { return { err: `${e?.name}: ${e?.message}` }; } };

  let profilesCompared = 0, caseCount = 0, caseMismatch = 0, ctxMismatch = 0, orderOnly = 0, errCases = 0;
  const examples = [];
  const sampleMismatches = [];

  for (const sku of sourceSkus) {
    const ref = { shopDomain: SHOP, sku };
    const a = await loadPricingContext(shim, ref);        // SQLite
    const b = await loadPricingContext(prisma, ref);      // target Neon
    profilesCompared++;
    const norm = (p) => stable({ ...p, quantityTiers: [...p.quantityTiers].sort((x, y) => x.id < y.id ? -1 : 1), decorationRules: [...p.decorationRules].sort((x, y) => x.id < y.id ? -1 : 1), decorationColorCharges: [...p.decorationColorCharges].sort((x, y) => x.id < y.id ? -1 : 1), productColors: [...p.productColors].sort((x, y) => x.id < y.id ? -1 : 1), productionRules: [...p.productionRules].sort((x, y) => x.id < y.id ? -1 : 1), packagingRules: [...p.packagingRules].sort((x, y) => x.id < y.id ? -1 : 1), optionGroups: [...p.optionGroups].sort((x, y) => x.id < y.id ? -1 : 1).map((g) => ({ ...g, optionValues: [...g.optionValues].sort((x, y) => x.id < y.id ? -1 : 1) })) });
    if (stable(a.profile) !== stable(b.profile)) { if (norm(a.profile) === norm(b.profile)) orderOnly++; else { ctxMismatch++; if (sampleMismatches.length < 3) sampleMismatches.push(`context differs for ${sku}`); } }

    // Deterministic case grid from the SOURCE profile data.
    const p = a.profile;
    const tiers = [...p.quantityTiers].sort((x, y) => x.minQuantity - y.minQuantity);
    const qtys = new Set([Math.max(1, (tiers[0]?.minQuantity ?? 1) - 1)]);
    for (const t of tiers) { qtys.add(t.minQuantity); if (t.maxQuantity != null) { qtys.add(t.maxQuantity); qtys.add(t.maxQuantity + 1); } else qtys.add(t.minQuantity + 500); }
    const methods = [...new Set(p.decorationRules.map((r) => r.method))];
    const decos = [undefined];
    for (const m of methods) {
      decos.push({ method: m, colors: 1, locations: 1, reverseSide: false, differentReverseArtwork: false, repeatOrder: false });
      decos.push({ method: m, colors: 2, locations: 1, reverseSide: false, differentReverseArtwork: false, repeatOrder: true });
      decos.push({ method: m, colors: 3, locations: 2, reverseSide: true, differentReverseArtwork: true, repeatOrder: false });
    }
    const baseQty = [...qtys].sort((x, y) => x - y)[Math.floor(qtys.size / 2)];
    const cases = [];
    for (const qn of qtys) cases.push({ quantity: qn });
    for (const d of decos) for (const qn of [baseQty, tiers[0]?.minQuantity ?? 1]) cases.push({ quantity: qn, decoration: d });
    const decoBase = decos[1];
    for (const g of p.optionGroups) for (const v of [g.optionValues[0], g.optionValues[g.optionValues.length - 1]]) if (v) cases.push({ quantity: baseQty, decoration: decoBase, options: [{ groupName: g.name, optionValueId: v.id }] });
    if (p.optionGroups.length) cases.push({ quantity: baseQty, decoration: decoBase, options: p.optionGroups.filter((g) => g.optionValues[0]).map((g) => ({ groupName: g.name, optionValueId: g.optionValues[0].id })) });
    for (const r of p.productionRules) cases.push({ quantity: baseQty, decoration: decoBase, production: { code: r.code } });
    for (const r of p.packagingRules) cases.push({ quantity: baseQty, decoration: decoBase, packaging: { code: r.code } });
    for (const c of p.productColors) cases.push({ quantity: baseQty, decoration: decoBase, productColor: { code: c.code } });

    for (const c of cases) {
      const input = { shopDomain: SHOP, sku, ...c };
      const ra = run(a.profile, a.source, input);
      const rb = run(b.profile, b.source, input);
      caseCount++; if (ra.err) errCases++;
      if (stable(ra) !== stable(rb)) { caseMismatch++; if (sampleMismatches.length < 3) sampleMismatches.push(`${sku} ${stable(c).slice(0, 120)}`); }
      else if (sku === "LNY01" && examples.length < 6 && ra.ok && c.decoration) examples.push({ sku, qty: c.quantity, deco: `${c.decoration.method}/${c.decoration.colors}c`, sqliteNetCents: ra.ok.totals.netTotalCents, neonNetCents: rb.ok.totals.netTotalCents, sqliteListCents: ra.ok.totals.listTotalCents, neonListCents: rb.ok.totals.listTotalCents });
    }
  }

  // The included product override: resolve via shopifyProductId on both sides.
  const oref = { shopDomain: SHOP, sku: "__no_such_sku__", shopifyProductId: OVERRIDE_PRODUCT };
  const oa = await loadPricingContext(shim, oref);
  const ob = await loadPricingContext(prisma, oref);
  const oin = { shopDomain: SHOP, sku: OVERRIDE_SKU, shopifyProductId: OVERRIDE_PRODUCT, quantity: Math.max(1, oa.profile.quantityTiers.map((t) => t.minQuantity).sort((x, y) => x - y)[0] ?? 1) };
  const ova = run(oa.profile, oa.source, oin), ovb = run(ob.profile, ob.source, oin);
  const overrideOk = oa.source.resolvedVia === "override" && ob.source.resolvedVia === "override" && oa.source.pricingProfileId === ob.source.pricingProfileId && stable(ova) === stable(ovb);
  if (!overrideOk) failures++;

  console.log(`profiles compared: ${profilesCompared}; contexts identical: ${profilesCompared - ctxMismatch - orderOnly}; same data but different array order: ${orderOnly}; contexts different: ${ctxMismatch}`);
  console.log(`quote cases compared: ${caseCount} (of which ${errCases} are expected-error cases, compared by error text); mismatches: ${caseMismatch}`);
  if (examples.length) console.table(examples);
  console.log(`override product ${OVERRIDE_PRODUCT}: resolvedVia sqlite=${oa.source.resolvedVia} neon=${ob.source.resolvedVia}; profile ${oa.source.pricingProfileId === ob.source.pricingProfileId ? "same" : "DIFFERENT"}; quote ${stable(ova) === stable(ovb) ? "IDENTICAL" : "DIFFERENT"}${ova.ok ? ` (net ${ova.ok.totals.netTotalCents}c / list ${ova.ok.totals.listTotalCents}c)` : ""}`);
  if (sampleMismatches.length) console.log("sample mismatches:", sampleMismatches);
  if (ctxMismatch || caseMismatch) failures++;

  console.log(`\nRESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK GROUP(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 2;
} finally {
  source.close();
  await prisma.$disconnect();
}
