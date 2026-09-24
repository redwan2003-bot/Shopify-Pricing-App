import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCatalogCsv, parseCsv, PROFILE_COLUMN, STATUS_COLUMN } from "./catalog-csv.ts";

const profile = (overrides: Record<string, unknown> = {}) => ({
  sku: "TEST01",
  currency: "USD",
  syncStatus: "ready_exact_match",
  quantityBreaks: [{ minQuantity: 100, maxQuantity: null, listPriceCents: 200, netPriceCents: 120 }],
  decorationRules: [
    {
      id: "screen_print",
      method: "Screen Print",
      charges: [
        { id: "setup_charge_one_color_one_location", label: "Setup", chargeType: "setup", listPriceCents: 4500, netPriceCents: 3600 },
        { id: "additional_color_run_charge", label: "Color run", chargeType: "per_unit", listPriceCents: 25, netPriceCents: 20 },
      ],
    },
  ],
  optionGroups: [{ name: "Heavy Duty Attachment", options: [{ id: "oval", name: "Oval Hook", listPriceAdjustmentCents: 31, netPriceAdjustmentCents: 23 }] }],
  productionRules: [{ id: "standard", name: "Standard", mode: "standard", leadTimeMinBusinessDays: 7, leadTimeMaxBusinessDays: 8 }],
  packagingRules: [{ id: "carton", name: "Carton", unitsPerCarton: 100 }],
  ...overrides,
});

const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
function csv(rows: { title: string; profile?: object | string; status?: string }[]) {
  const header = ["Title", "Price", PROFILE_COLUMN, STATUS_COLUMN].map(csvCell).join(",");
  const lines = rows.map((r) =>
    [r.title, "4.55", r.profile === undefined ? "" : typeof r.profile === "string" ? r.profile : JSON.stringify(r.profile), r.status ?? ""]
      .map(csvCell)
      .join(","),
  );
  return "﻿" + [header, ...lines].join("\r\n") + "\r\n";
}

test("parseCsv handles quoted commas, embedded newlines and doubled quotes", () => {
  assert.deepEqual(parseCsv('a,"b,c","d\n""e"""\r\n1,2,3\n'), [
    ["a", "b,c", 'd\n"e"'],
    ["1", "2", "3"],
  ]);
});

test("imports exact matches, maps charges onto the calculator's codes, and keeps option net prices", () => {
  const a = analyzeCatalogCsv(csv([{ title: "Test Lanyard", profile: profile(), status: "ready_exact_match" }, { title: "variant row" }]), "s.myshopify.com");
  assert.equal(a.missingColumns, false);
  assert.equal(a.productsWithProfile, 1);
  assert.equal(a.toImport.length, 1);
  const input = a.toImport[0]!.input;
  assert.equal(input.name, "Test Lanyard (TEST01)");
  assert.deepEqual(input.decorationRules.map((r) => r.code), ["SETUP_1C1L"]);
  assert.equal(input.decorationColorCharges![0]!.colorNumber, 2, "additional-color charges go to the per-color table");
  assert.equal(input.optionGroups[0]!.kind, "ATTACHMENT");
  assert.equal(input.optionGroups[0]!.values[0]!.netPriceAdjustmentCents, 23);
  assert.deepEqual(a.currencies, ["USD"]);
});

test("holds back non-exact statuses, bad JSON, unknown methods and missing packaging — with reasons", () => {
  const a = analyzeCatalogCsv(
    csv([
      { title: "Derived", profile: profile({ sku: "D1" }), status: "ready_derived_family_match" },
      { title: "Broken", profile: "{not json", status: "ready_exact_match" },
      { title: "Odd method", profile: profile({ sku: "M1", decorationRules: [{ id: "x", method: "Set-Up", charges: [] }] }), status: "ready_exact_match" },
      { title: "No carton", profile: profile({ sku: "P1", packagingRules: [] }), status: "ready_exact_match" },
    ]),
    "s.myshopify.com",
  );
  assert.equal(a.toImport.length, 0);
  assert.equal(a.holdBacks.length, 4);
  const reasons = a.holdBacks.map((h) => h.reason).join(" | ");
  assert.match(reasons, /not an exact match/);
  assert.match(reasons, /not valid JSON/);
  assert.match(reasons, /unrecognized decoration method/);
  assert.match(reasons, /no packagingRules/);
});

test("a file without the pricing columns is flagged as the wrong file", () => {
  assert.equal(analyzeCatalogCsv("Title,Price\nMug,5\n", "s.myshopify.com").missingColumns, true);
  assert.equal(analyzeCatalogCsv("", "s.myshopify.com").missingColumns, true);
});
