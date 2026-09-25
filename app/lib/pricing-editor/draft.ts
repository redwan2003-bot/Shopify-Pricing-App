import type { DecorationChargeBasis, DecorationMethod, OptionGroupKind } from "@prisma/client";
import type { PricingProfileImportInput, PackagingRuleInput, ProductColorInput } from "../pricing-import/types.ts";

/**
 * The editable form of a pricing profile. Money is kept as the exact text the merchant typed
 * ("1.37") and converted to whole cents only on save, so no value ever passes through floating
 * point. A blank price means "not supplied" (never $0), matching the rest of this system.
 *
 * Decoration is edited as fixed "slots" because the calculator looks charges up by fixed codes
 * (see app/lib/pricing/calculator.ts#DECORATION_CODES) and colour 2 through the per-colour table:
 * a slot left blank simply isn't offered, and the storefront hides the matching control.
 */

export const DECORATION_METHODS = ["SCREEN_PRINT", "SUBLIMATION", "WOVEN", "EMBROIDERY", "DTF", "DTG", "VINYL", "OTHER"] as const;

export const DECORATION_SLOTS = [
  { key: "SETUP_1C1L", label: "Setup (1 colour, 1 location)", basis: "ONE_TIME", required: true },
  { key: "SECOND_LOCATION_RUN", label: "2nd location, per piece", basis: "PER_UNIT", required: false },
  { key: "REVERSE_SIDE_SETUP", label: "Reverse side setup (different art)", basis: "ONE_TIME", required: false },
  { key: "REPEAT_ORDER_SETUP", label: "Repeat order setup", basis: "ONE_TIME", required: false },
  { key: "COLOR_2_SETUP", label: "2nd colour setup", basis: "ONE_TIME", required: false },
  { key: "COLOR_2_RUN", label: "2nd colour, per piece", basis: "PER_UNIT", required: false },
] as const;
export type DecorationSlotKey = (typeof DECORATION_SLOTS)[number]["key"];

export interface MoneyPair {
  list: string;
  net: string;
}

export interface DraftTier {
  min: string;
  max: string;
  list: string;
  net: string;
}
export interface DraftDecoration {
  method: string;
  /** Slot key -> prices; a slot with both prices blank is not offered. */
  slots: Partial<Record<DecorationSlotKey, MoneyPair & { name: string }>>;
}
export interface DraftOptionValue {
  label: string;
  code: string;
  list: string;
  net: string;
  isDefault: boolean;
}
export interface DraftOptionGroup {
  name: string;
  kind: string;
  isRequired: boolean;
  values: DraftOptionValue[];
}
export interface DraftProduction {
  code: string;
  name: string;
  isRush: boolean;
  minDays: string;
  maxDays: string;
  fee: string;
  notes: string;
}
export interface PricingDraft {
  sku: string;
  name: string;
  description: string;
  currency: string;
  tiers: DraftTier[];
  decorations: DraftDecoration[];
  optionGroups: DraftOptionGroup[];
  production: DraftProduction[];
}

export type DraftError = { field: string; message: string };

// ---------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------

/** "" -> null (not supplied); "1", "1.3", "1.37", "$1.37" -> cents; anything else -> error. */
export function parseMoney(text: string): { ok: true; cents: number | null } | { ok: false } {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (t === "") return { ok: true, cents: null };
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return { ok: false };
  return { ok: true, cents: Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") };
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function parseWhole(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim().replace(/,/g, "");
  if (t === "") return { ok: true, value: null };
  return /^\d{1,9}$/.test(t) ? { ok: true, value: Number(t) } : { ok: false };
}

// ---------------------------------------------------------------------------------------
// Database profile -> draft
// ---------------------------------------------------------------------------------------

export interface StoredProfile {
  sku: string | null;
  name: string;
  description: string | null;
  currency: string;
  quantityTiers: { minQuantity: number; maxQuantity: number | null; listPriceCents: number; netPriceCents: number }[];
  decorationRules: { method: string; code: string; name: string; listPriceCents: number; netPriceCents: number }[];
  decorationColorCharges: { method: string; colorNumber: number; chargeBasis: string; listPriceCents: number; netPriceCents: number; isActive: boolean }[];
  optionGroups: {
    name: string;
    kind: string;
    isRequired: boolean;
    sortOrder: number;
    optionValues: { label: string; code: string | null; priceAdjustmentCents: number | null; netPriceAdjustmentCents: number | null; isDefault: boolean; sortOrder: number }[];
  }[];
  productionRules: { code: string; name: string; isRush: boolean; minBusinessDays: number; maxBusinessDays: number | null; feeCents: number | null; notes: string | null }[];
}

export function profileToDraft(p: StoredProfile): PricingDraft {
  const methods = [...new Set([...p.decorationRules.map((r) => r.method), ...p.decorationColorCharges.map((c) => c.method)])];
  return {
    sku: p.sku ?? "",
    name: p.name,
    description: p.description ?? "",
    currency: p.currency,
    tiers: [...p.quantityTiers]
      .sort((a, b) => a.minQuantity - b.minQuantity)
      .map((t) => ({ min: String(t.minQuantity), max: t.maxQuantity === null ? "" : String(t.maxQuantity), list: formatMoney(t.listPriceCents), net: formatMoney(t.netPriceCents) })),
    decorations: methods.map((method) => {
      const slots: DraftDecoration["slots"] = {};
      for (const r of p.decorationRules.filter((x) => x.method === method)) {
        if (DECORATION_SLOTS.some((s) => s.key === r.code)) {
          slots[r.code as DecorationSlotKey] = { name: r.name, list: formatMoney(r.listPriceCents), net: formatMoney(r.netPriceCents) };
        }
      }
      for (const c of p.decorationColorCharges.filter((x) => x.method === method && x.isActive && x.colorNumber === 2)) {
        const key = c.chargeBasis === "PER_UNIT" ? "COLOR_2_RUN" : "COLOR_2_SETUP";
        slots[key] = { name: "", list: formatMoney(c.listPriceCents), net: formatMoney(c.netPriceCents) };
      }
      return { method, slots };
    }),
    optionGroups: [...p.optionGroups]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((g) => ({
        name: g.name,
        kind: g.kind,
        isRequired: g.isRequired,
        values: [...g.optionValues]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((v) => ({ label: v.label, code: v.code ?? "", list: formatMoney(v.priceAdjustmentCents), net: formatMoney(v.netPriceAdjustmentCents), isDefault: v.isDefault })),
      })),
    production: p.productionRules.map((r) => ({
      code: r.code,
      name: r.name,
      isRush: r.isRush,
      minDays: String(r.minBusinessDays),
      maxDays: r.maxBusinessDays === null ? "" : String(r.maxBusinessDays),
      fee: formatMoney(r.feeCents),
      notes: r.notes ?? "",
    })),
  };
}

export function blankDraft(currency: string): PricingDraft {
  return {
    sku: "",
    name: "",
    description: "",
    currency,
    tiers: [{ min: "100", max: "", list: "", net: "" }],
    decorations: [],
    optionGroups: [],
    production: [{ code: "STANDARD", name: "Standard production", isRush: false, minDays: "7", maxDays: "10", fee: "", notes: "" }],
  };
}

// ---------------------------------------------------------------------------------------
// Draft -> import input (validated by importPricingProfile as well)
// ---------------------------------------------------------------------------------------

/** Packaging and product colours are not edited here; the caller passes the stored ones through. */
export interface Passthrough {
  packagingRules: PackagingRuleInput[];
  productColors: ProductColorInput[];
}

const DEFAULT_PACKAGING: PackagingRuleInput = { code: "STANDARD_CARTON", name: "Standard carton" };

export function draftToImportInput(
  draft: PricingDraft,
  shopDomain: string,
  passthrough: Passthrough,
): { ok: true; input: PricingProfileImportInput } | { ok: false; errors: DraftError[] } {
  const errors: DraftError[] = [];
  const money = (text: string, field: string): number | null => {
    const r = parseMoney(text);
    if (!r.ok) {
      errors.push({ field, message: "Enter an amount like 1.37" });
      return null;
    }
    return r.cents;
  };
  const required = (text: string, field: string): number => {
    const v = money(text, field);
    if (v === null && parseMoney(text).ok) errors.push({ field, message: "A price is required here" });
    return v ?? 0;
  };
  const whole = (text: string, field: string, need: boolean): number | null => {
    const r = parseWhole(text);
    if (!r.ok) {
      errors.push({ field, message: "Enter a whole number" });
      return null;
    }
    if (need && r.value === null) errors.push({ field, message: "Required" });
    return r.value;
  };

  const sku = draft.sku.trim();
  if (!sku) errors.push({ field: "sku", message: "The SKU is required" });
  else if (!/^[A-Za-z0-9._-]{1,64}$/.test(sku)) errors.push({ field: "sku", message: "Use letters, numbers, dot, dash or underscore" });
  const name = draft.name.trim();
  if (!name) errors.push({ field: "name", message: "A name is required" });
  if (!/^[A-Z]{3}$/.test(draft.currency)) errors.push({ field: "currency", message: "Use a 3-letter currency code" });

  if (draft.tiers.length === 0) errors.push({ field: "tiers", message: "Add at least one quantity break" });
  const quantityTiers = draft.tiers.map((t, i) => ({
    minQuantity: whole(t.min, `tiers.${i}.min`, true) ?? 0,
    maxQuantity: whole(t.max, `tiers.${i}.max`, false),
    listPriceCents: required(t.list, `tiers.${i}.list`),
    netPriceCents: required(t.net, `tiers.${i}.net`),
  }));

  const decorationRules: PricingProfileImportInput["decorationRules"] = [];
  const decorationColorCharges: NonNullable<PricingProfileImportInput["decorationColorCharges"]> = [];
  const seenMethods = new Set<string>();
  draft.decorations.forEach((d, i) => {
    if (!(DECORATION_METHODS as readonly string[]).includes(d.method)) errors.push({ field: `decorations.${i}.method`, message: "Choose a decoration method" });
    if (seenMethods.has(d.method)) errors.push({ field: `decorations.${i}.method`, message: "This method is listed twice" });
    seenMethods.add(d.method);
    for (const slot of DECORATION_SLOTS) {
      const s = d.slots[slot.key];
      const blank = !s || (s.list.trim() === "" && s.net.trim() === "");
      if (blank) {
        if (slot.required) errors.push({ field: `decorations.${i}.${slot.key}`, message: "Every decoration method needs a setup price" });
        continue;
      }
      const list = required(s!.list, `decorations.${i}.${slot.key}.list`);
      const net = required(s!.net, `decorations.${i}.${slot.key}.net`);
      const method = d.method as DecorationMethod;
      const chargeBasis = slot.basis as DecorationChargeBasis;
      if (slot.key === "COLOR_2_SETUP" || slot.key === "COLOR_2_RUN") {
        decorationColorCharges.push({ method, colorNumber: 2, chargeBasis, listPriceCents: list, netPriceCents: net });
      } else {
        decorationRules.push({ method, code: slot.key, name: s!.name.trim() || slot.label, chargeBasis, listPriceCents: list, netPriceCents: net, sortOrder: decorationRules.length });
      }
    }
  });

  const optionGroups = draft.optionGroups.map((g, gi) => {
    if (!g.name.trim()) errors.push({ field: `optionGroups.${gi}.name`, message: "Name this group" });
    if (g.values.length === 0) errors.push({ field: `optionGroups.${gi}.values`, message: "Add at least one choice" });
    return {
      name: g.name.trim(),
      kind: (["ATTACHMENT", "FEATURE", "GENERIC"].includes(g.kind) ? g.kind : "GENERIC") as OptionGroupKind,
      isRequired: g.isRequired,
      sortOrder: gi,
      categoryPriceAdjustmentCents: null,
      values: g.values.map((v, vi) => {
        if (!v.label.trim()) errors.push({ field: `optionGroups.${gi}.values.${vi}.label`, message: "Name this choice" });
        return {
          label: v.label.trim(),
          code: v.code.trim() || null,
          priceAdjustmentCents: money(v.list, `optionGroups.${gi}.values.${vi}.list`),
          netPriceAdjustmentCents: money(v.net, `optionGroups.${gi}.values.${vi}.net`),
          isDefault: v.isDefault,
          sortOrder: vi,
        };
      }),
    };
  });

  if (draft.production.length === 0) errors.push({ field: "production", message: "Add at least one production option" });
  if (draft.production.filter((r) => !r.isRush).length !== 1) {
    errors.push({ field: "production", message: "Mark exactly one production option as the standard (non-rush) one" });
  }
  const productionRules = draft.production.map((r, i) => ({
    code: (r.code.trim() || `RULE_${i + 1}`).toUpperCase(),
    name: r.name.trim() || "Production",
    isRush: r.isRush,
    minBusinessDays: whole(r.minDays, `production.${i}.minDays`, true) ?? 1,
    maxBusinessDays: whole(r.maxDays, `production.${i}.maxDays`, false),
    feeCents: money(r.fee, `production.${i}.fee`),
    notes: r.notes.trim() || null,
  }));

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      shopDomain,
      sku,
      name,
      description: draft.description.trim() || null,
      isDefault: true,
      currency: draft.currency,
      quantityTiers,
      decorationRules,
      decorationColorCharges,
      optionGroups,
      productColors: passthrough.productColors,
      productionRules,
      packagingRules: passthrough.packagingRules.length ? passthrough.packagingRules : [DEFAULT_PACKAGING],
    },
  };
}
