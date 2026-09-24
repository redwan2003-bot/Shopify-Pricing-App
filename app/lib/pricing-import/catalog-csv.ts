/**
 * Reads the ImprintID catalog CSV (a Shopify product export with two extra columns:
 * `product.metafields.imprintid_pricing.profile`, a JSON pricing package per product, and
 * `...sync_status`, how confidently that JSON was derived) and turns it into pricing profiles.
 * Shared by the admin "Import pricing" page and scripts/import-catalog-pricing.ts.
 *
 * Only `sync_status === "ready_exact_match"` rows are imported — other statuses mean the source
 * data itself flagged the pricing as incomplete or inferred. A row whose JSON doesn't fit this
 * app's pricing model is held back with a reason; nothing is imported by guessing.
 */
import { DecorationMethod, DecorationChargeBasis, OptionGroupKind, ProductionFeeType, type PrismaClient } from "@prisma/client";
import { importPricingProfile, PricingImportValidationError } from "./import.ts";
import type {
  PricingProfileImportInput,
  DecorationRuleInput,
  DecorationColorChargeInput,
  OptionGroupInput,
  ProductionRuleInput,
  PackagingRuleInput,
} from "./types.ts";

export const PROFILE_COLUMN = "ImprintID Pricing Profile (product.metafields.imprintid_pricing.profile)";
export const STATUS_COLUMN = "ImprintID Pricing Sync Status (product.metafields.imprintid_pricing.sync_status)";

// The only decoration "method" strings this source data has ever been observed to use
// for a real, priceable technique. Anything else (e.g. a mis-scraped column label like
// "Set Up Charge After Login") is held back, never guessed at.
const METHOD_MAP: Record<string, DecorationMethod> = {
  "Screen Print": DecorationMethod.SCREEN_PRINT,
  "Sublimation": DecorationMethod.SUBLIMATION,
  "Woven": DecorationMethod.WOVEN,
};

const CHARGE_TYPE_MAP: Record<string, DecorationChargeBasis> = {
  setup: DecorationChargeBasis.ONE_TIME,
  per_unit: DecorationChargeBasis.PER_UNIT,
};

// app/lib/pricing/calculator.ts#DECORATION_CODES is a FIXED vocabulary the calculator
// requires by exact code, not a data-driven lookup — every priced configuration needs a
// DecorationRule whose `code` is one of these four strings for the method being priced.
// This maps the source JSON's free-form charge ids (verified exhaustively against every
// "ready_exact_match" profile — see the import investigation) onto that vocabulary. An
// id not listed here is NOT silently dropped or guessed at — see `error` below.
const BASE_SETUP_CHARGE_IDS = new Set([
  "setup_charge_one_color_one_location", // Screen Print
  "full_color_sublimation_setup_charge", // Sublimation
  "front_and_back_full_color_edge_to_edge_digital_printed_setup_charge", // Sublimation (double-sided)
  "setup_charge", // Woven
]);
const REVERSE_SIDE_CHARGE_IDS = new Set(["reverse_side_setup_if_different_art"]);
const SECOND_LOCATION_CHARGE_IDS = new Set(["2nd_location_run_charge"]);
const REPEAT_ORDER_CHARGE_IDS = new Set(["repeat_order_setup_charge"]);
// These aren't a DecorationRule at all — they're per-color pricing (Phase 2.7's
// DecorationColorCharge table, keyed by method+colorNumber), never looked up by a fixed
// code. Every occurrence in the source data is the color-2 charge (the calculator has no
// concept of "additional colors" beyond that table).
const ADDITIONAL_COLOR_SETUP_CHARGE_IDS = new Set(["additional_color_setup_charge"]);
const ADDITIONAL_COLOR_RUN_CHARGE_IDS = new Set(["additional_color_run_charge"]);

// ---------------------------------------------------------------------------
// Minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines, "" escapes).
// Kept dependency-free: the catalog export is the only CSV this app reads.
// ---------------------------------------------------------------------------
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function recordsFromCsvText(text: string): Record<string, string>[] {
  const table = parseCsv(text.replace(/^\uFEFF/, ""));
  const header = table[0] ?? [];
  return table.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key] = cells[idx] ?? "";
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Source JSON -> PricingProfileImportInput
// ---------------------------------------------------------------------------
export interface HoldBack {
  sku: string;
  title: string;
  reason: string;
}

interface SourceCharge {
  id: string;
  label: string;
  chargeType: string;
  listPriceCents: number;
  netPriceCents: number;
}

interface SourceDecorationGroup { id: string; method: string; charges?: SourceCharge[]; }
interface SourceOption { id?: string; name: string; includedInBasePrice?: boolean; listPriceAdjustmentCents?: number | null; netPriceAdjustmentCents?: number | null; }
interface SourceOptionGroup { name: string; options?: SourceOption[]; }
interface SourceQuantityBreak { minQuantity: number; maxQuantity?: number | null; listPriceCents: number; netPriceCents: number; }
interface SourceProductionRule { id: string; name: string; mode: string; leadTimeMinBusinessDays: number; leadTimeMaxBusinessDays?: number | null; priceAdjustmentCents?: number | null; pricingNote?: string | null; sourceText?: string | null; }
interface SourcePackagingRule { id: string; name: string; unitsPerCarton?: number | null; cartonWeightLbs?: number | null; cartonLengthInches?: number | null; cartonWidthInches?: number | null; cartonHeightInches?: number | null; source?: string | null; cartonMappingIds?: string[]; }
interface SourceProfile {
  sku?: string;
  syncStatus?: string;
  currency?: string;
  quantityBreaks?: SourceQuantityBreak[];
  decorationRules?: SourceDecorationGroup[];
  optionGroups?: SourceOptionGroup[];
  productionRules?: SourceProductionRule[];
  packagingRules?: SourcePackagingRule[];
}

export function transformProfile(
  shopDomain: string,
  title: string,
  profile: SourceProfile,
): { input: PricingProfileImportInput } | { error: string } {
  const sku = profile.sku;
  if (typeof sku !== "string" || sku.trim().length === 0) {
    return { error: "profile JSON has no sku" };
  }

  const quantityBreaks = Array.isArray(profile.quantityBreaks) ? profile.quantityBreaks : [];
  if (quantityBreaks.length === 0) {
    return { error: "no quantityBreaks in source JSON" };
  }

  const sourceProductionRules = Array.isArray(profile.productionRules) ? profile.productionRules : [];
  if (sourceProductionRules.length === 0) {
    return { error: "no productionRules in source JSON" };
  }

  const sourcePackagingRules = Array.isArray(profile.packagingRules) ? profile.packagingRules : [];
  if (sourcePackagingRules.length === 0) {
    return { error: "no packagingRules in source JSON" };
  }

  const decorationRules: DecorationRuleInput[] = [];
  const decorationColorCharges: DecorationColorChargeInput[] = [];
  for (const group of Array.isArray(profile.decorationRules) ? profile.decorationRules : []) {
    const method = METHOD_MAP[group.method];
    if (!method) {
      return { error: `unrecognized decoration method "${group.method}" (group "${group.id}")` };
    }
    for (const charge of Array.isArray(group.charges) ? group.charges : []) {
      const chargeBasis = CHARGE_TYPE_MAP[charge.chargeType];
      if (!chargeBasis) {
        return {
          error: `unrecognized decoration chargeType "${charge.chargeType}" (${group.id}/${charge.id})`,
        };
      }

      if (ADDITIONAL_COLOR_SETUP_CHARGE_IDS.has(charge.id) || ADDITIONAL_COLOR_RUN_CHARGE_IDS.has(charge.id)) {
        decorationColorCharges.push({
          method,
          colorNumber: 2,
          chargeBasis,
          listPriceCents: charge.listPriceCents,
          netPriceCents: charge.netPriceCents,
        });
        continue;
      }

      let code: string;
      if (BASE_SETUP_CHARGE_IDS.has(charge.id)) code = "SETUP_1C1L";
      else if (REVERSE_SIDE_CHARGE_IDS.has(charge.id)) code = "REVERSE_SIDE_SETUP";
      else if (SECOND_LOCATION_CHARGE_IDS.has(charge.id)) code = "SECOND_LOCATION_RUN";
      else if (REPEAT_ORDER_CHARGE_IDS.has(charge.id)) code = "REPEAT_ORDER_SETUP";
      else return { error: `unrecognized decoration charge id "${charge.id}" for method "${group.method}" — no calculator code mapping exists` };

      decorationRules.push({
        method,
        code,
        name: charge.label,
        chargeBasis,
        listPriceCents: charge.listPriceCents,
        netPriceCents: charge.netPriceCents,
        sortOrder: decorationRules.length,
      });
    }
  }

  const optionGroups: OptionGroupInput[] = (Array.isArray(profile.optionGroups) ? profile.optionGroups : []).map(
    (group, groupIndex) => ({
      name: group.name,
      // The storefront shows ATTACHMENT groups in their own "Attachments" panel and everything
      // else under "Optional Features", keyed off this kind — GENERIC for all of them lumped
      // every attachment under the wrong heading.
      kind: /attachment/i.test(group.name) ? OptionGroupKind.ATTACHMENT : OptionGroupKind.FEATURE,
      sortOrder: groupIndex,
      categoryPriceAdjustmentCents: null,
      values: (Array.isArray(group.options) ? group.options : []).map((option, valueIndex) => ({
        code: option.id ?? null,
        label: option.name,
        priceAdjustmentCents: option.listPriceAdjustmentCents ?? null,
        netPriceAdjustmentCents: option.netPriceAdjustmentCents ?? null,
        isDefault: option.includedInBasePrice === true,
        sortOrder: valueIndex,
      })),
    }),
  );

  const productionRules: ProductionRuleInput[] = sourceProductionRules.map((p) => ({
    code: String(p.id).toUpperCase(),
    name: p.name,
    isRush: p.mode === "rush",
    minBusinessDays: p.leadTimeMinBusinessDays,
    maxBusinessDays: p.leadTimeMaxBusinessDays ?? null,
    feeCents: p.priceAdjustmentCents ?? null,
    feeType: ProductionFeeType.FLAT,
    notes: p.pricingNote ?? p.sourceText ?? null,
  }));

  const packagingRules: PackagingRuleInput[] = sourcePackagingRules.map((p) => ({
    code: String(p.id).toUpperCase(),
    name: p.name,
    unitsPerPackage: p.unitsPerCarton ?? null,
    cartonWeightLbs: p.cartonWeightLbs ?? null,
    lengthIn: p.cartonLengthInches ?? null,
    widthIn: p.cartonWidthInches ?? null,
    heightIn: p.cartonHeightInches ?? null,
    feeCents: null,
    notes: p.source ?? (Array.isArray(p.cartonMappingIds) ? p.cartonMappingIds.join(", ") : null),
  }));

  // PricingProfile.name must be unique per store, but the source catalog reuses the
  // exact same generic title across genuinely distinct SKUs (e.g. every width of
  // "Polyester Lanyards with Detachable Buckle Release" shares one title) — so the
  // SKU, which IS guaranteed unique, is always appended rather than relied on only
  // when a collision happens to occur.
  const name = title ? `${title} (${sku})` : sku;

  const input: PricingProfileImportInput = {
    shopDomain,
    sku,
    name,
    description: `Imported from ImprintID catalog pricing sync (source sync status: ${profile.syncStatus}).`,
    isDefault: true,
    currency: profile.currency ?? "USD",
    quantityTiers: quantityBreaks.map((t) => ({
      minQuantity: t.minQuantity,
      maxQuantity: t.maxQuantity ?? null,
      listPriceCents: t.listPriceCents,
      netPriceCents: t.netPriceCents,
    })),
    decorationRules,
    decorationColorCharges,
    optionGroups,
    productionRules,
    packagingRules,
  };

  return { input };
}


// ---------------------------------------------------------------------------
// Whole-file analysis + import
// ---------------------------------------------------------------------------

export interface CatalogAnalysis {
  /** Rows that carried a pricing profile column (one per product). */
  productsWithProfile: number;
  toImport: { title: string; input: PricingProfileImportInput }[];
  holdBacks: HoldBack[];
  /** Distinct currencies across importable profiles, e.g. ["USD"]. */
  currencies: string[];
  /** The file has none of the expected pricing columns (wrong file). */
  missingColumns: boolean;
}

export function analyzeCatalogCsv(text: string, shopDomain: string): CatalogAnalysis {
  const records = recordsFromCsvText(text);
  const missingColumns = records.length === 0 || !(PROFILE_COLUMN in records[0]!);
  const holdBacks: HoldBack[] = [];
  const toImport: { title: string; input: PricingProfileImportInput }[] = [];
  let productsWithProfile = 0;

  for (const row of records) {
    const raw = (row[PROFILE_COLUMN] ?? "").trim();
    if (!raw) continue;
    productsWithProfile += 1;
    const title = row["Title"] ?? "";
    let profile: SourceProfile;
    try {
      profile = JSON.parse(raw) as SourceProfile;
    } catch {
      holdBacks.push({ sku: "(unknown sku)", title, reason: "the pricing column is not valid JSON" });
      continue;
    }
    const sku = typeof profile.sku === "string" ? profile.sku : "(unknown sku)";
    const status = (row[STATUS_COLUMN] ?? "").trim();
    if (status !== "ready_exact_match") {
      holdBacks.push({ sku, title, reason: `sync status is "${status || "(blank)"}", not an exact match` });
      continue;
    }
    const result = transformProfile(shopDomain, title, profile);
    if ("error" in result) {
      holdBacks.push({ sku, title, reason: result.error });
      continue;
    }
    toImport.push({ title, input: result.input });
  }

  const currencies = [...new Set(toImport.map((t) => t.input.currency ?? "USD"))].sort();
  return { productsWithProfile, toImport, holdBacks, currencies, missingColumns };
}

export interface CatalogImportResult {
  imported: number;
  /** Profiles whose priced content actually changed (a re-import of identical data is 0). */
  changed: number;
  failures: HoldBack[];
}

/** Imports each profile in its own transaction; one failing SKU never stops the rest. */
export async function importAnalyzedProfiles(
  prisma: PrismaClient,
  toImport: CatalogAnalysis["toImport"],
  onProgress?: (done: number, total: number) => void,
): Promise<CatalogImportResult> {
  let imported = 0;
  let changed = 0;
  const failures: HoldBack[] = [];
  for (const [i, { input }] of toImport.entries()) {
    try {
      const result = await importPricingProfile(prisma, input);
      imported += 1;
      if (result.revisionChanged) changed += 1;
    } catch (e) {
      const reason =
        e instanceof PricingImportValidationError
          ? `validation failed: ${e.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`
          : `import failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      failures.push({ sku: input.sku, title: input.name, reason });
    }
    onProgress?.(i + 1, toImport.length);
  }
  return { imported, changed, failures };
}
