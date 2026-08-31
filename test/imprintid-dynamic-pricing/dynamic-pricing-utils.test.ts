import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMoney,
  slugify,
  classifyResolvedPriceCents,
  parseProductVariantGid,
  parseProductGid,
  isPositiveDigitString,
  parseVariantMap,
  resolveVariantFromMap,
  readVariantMap,
} from "../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing-utils.js";

test("formatMoney formats integer cents as USD currency", () => {
  assert.equal(formatMoney(2900), "$29.00");
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(5), "$0.05");
});

test("formatMoney returns an em dash for a non-numeric value (e.g. null)", () => {
  assert.equal(formatMoney(null), "—");
  assert.equal(formatMoney(undefined), "—");
  assert.equal(formatMoney(NaN), "—");
});

test("slugify produces a lowercase, hyphenated, trimmed identifier", () => {
  assert.equal(slugify("Attachment — Heavy Duty"), "attachment-heavy-duty");
  assert.equal(slugify("  Leading/Trailing  "), "leading-trailing");
});

// classifyResolvedPriceCents is pure display bucketing of an ALREADY-resolved price —
// it takes no "category" fallback argument at all, because that precedence
// (OptionValue.priceAdjustmentCents falling back to OptionGroup.
// categoryPriceAdjustmentCents) is now resolved once, server-side, by
// app/lib/pricing/calculator.ts#resolveOptionValuePrice (see catalog.test.ts's
// "resolvedPriceCents/priceSource" tests for that resolution against real LNY01 data).
// This function only decides how to *display* one already-final number.
test("classifyResolvedPriceCents: a positive resolved price is \"priced\"", () => {
  const result = classifyResolvedPriceCents(125);
  assert.deepEqual(result, { kind: "priced", cents: 125 });
});

test("classifyResolvedPriceCents: a resolved price of exactly 0 is \"included\", not \"unavailable\"", () => {
  // LNY01's real "Attachment — Standard" resolves to a confirmed $0.
  const result = classifyResolvedPriceCents(0);
  assert.deepEqual(result, { kind: "included" });
});

test("classifyResolvedPriceCents: null is \"unavailable\", never a fabricated price", () => {
  const result = classifyResolvedPriceCents(null);
  assert.deepEqual(result, { kind: "unavailable" });
});

test("classifyResolvedPriceCents: undefined is treated the same as null", () => {
  const result = classifyResolvedPriceCents(undefined);
  assert.deepEqual(result, { kind: "unavailable" });
});

test("classifyResolvedPriceCents: a negative resolved price is still \"priced\" (formatMoney supplies the sign)", () => {
  const result = classifyResolvedPriceCents(-50);
  assert.deepEqual(result, { kind: "priced", cents: -50 });
});

// --- parseProductVariantGid (Task 2B, requirement B) ------------------------------
// Test #3 from the Task 2B matrix: "A valid ProductVariant GID resolves to its numeric
// ID without Number conversion." Asserted here by using an id string that would lose
// precision if ever routed through `Number(...)`/`parseInt(...)`.

test("parseProductVariantGid: a well-formed GID resolves to its numeric id, as a string", () => {
  assert.equal(parseProductVariantGid("gid://shopify/ProductVariant/51028263796988"), "51028263796988");
});

test("parseProductVariantGid: an id beyond Number.MAX_SAFE_INTEGER survives intact (never routed through Number())", () => {
  const hugeId = "99999999999999999999"; // far beyond 2^53-1
  assert.equal(parseProductVariantGid("gid://shopify/ProductVariant/" + hugeId), hugeId);
});

test("parseProductVariantGid: rejects a bare numeric id (no gid:// form)", () => {
  assert.equal(parseProductVariantGid("51028263796988"), null);
});

test("parseProductVariantGid: rejects the wrong resource type", () => {
  assert.equal(parseProductVariantGid("gid://shopify/Product/51028263796988"), null);
});

test("parseProductVariantGid: rejects a zero or leading-zero id", () => {
  assert.equal(parseProductVariantGid("gid://shopify/ProductVariant/0"), null);
  assert.equal(parseProductVariantGid("gid://shopify/ProductVariant/0123"), null);
});

test("parseProductVariantGid: rejects a missing id, non-digit id, and non-string input", () => {
  assert.equal(parseProductVariantGid("gid://shopify/ProductVariant/"), null);
  assert.equal(parseProductVariantGid("gid://shopify/ProductVariant/abc"), null);
  assert.equal(parseProductVariantGid(undefined), null);
  assert.equal(parseProductVariantGid(null), null);
  assert.equal(parseProductVariantGid(12345), null);
});

test("parseProductGid: mirrors parseProductVariantGid for the Product resource type", () => {
  assert.equal(parseProductGid("gid://shopify/Product/9442404663548"), "9442404663548");
  assert.equal(parseProductGid("gid://shopify/ProductVariant/9442404663548"), null);
  assert.equal(parseProductGid("not-a-gid"), null);
});

// --- isPositiveDigitString ---------------------------------------------------------

test("isPositiveDigitString: accepts a plain positive-integer digit string", () => {
  assert.equal(isPositiveDigitString("51028263796988"), true);
  assert.equal(isPositiveDigitString("1"), true);
});

test("isPositiveDigitString: rejects zero, leading zeros, non-digits, and non-strings", () => {
  assert.equal(isPositiveDigitString("0"), false);
  assert.equal(isPositiveDigitString("0123"), false);
  assert.equal(isPositiveDigitString("12a"), false);
  assert.equal(isPositiveDigitString(""), false);
  assert.equal(isPositiveDigitString(12345), false);
  assert.equal(isPositiveDigitString(undefined), false);
  assert.equal(isPositiveDigitString(null), false);
});

// --- parseVariantMap / resolveVariantFromMap ---------------------------------------

test("parseVariantMap: parses a well-formed JSON object built the way dynamic-pricing.liquid builds it", () => {
  const map = parseVariantMap('{"1001":{"sku":"LNY01-BLACK","available":true},"1002":{"sku":"LNY01-RED","available":false}}');
  assert.deepEqual(map, {
    "1001": { sku: "LNY01-BLACK", available: true },
    "1002": { sku: "LNY01-RED", available: false },
  });
});

test("parseVariantMap: fails closed to {} on malformed JSON, undefined, an array, or a non-string", () => {
  assert.deepEqual(parseVariantMap("{not json"), {});
  assert.deepEqual(parseVariantMap(undefined), {});
  assert.deepEqual(parseVariantMap(""), {});
  assert.deepEqual(parseVariantMap("[1,2,3]"), {});
  assert.deepEqual(parseVariantMap("null"), {});
  assert.deepEqual(parseVariantMap(42), {});
});

test("resolveVariantFromMap: resolves a present, well-shaped entry", () => {
  const map = { "1001": { sku: "LNY01-BLACK", available: true } };
  assert.deepEqual(resolveVariantFromMap(map, "1001"), { sku: "LNY01-BLACK", available: true });
});

test("resolveVariantFromMap: returns null for an id absent from the map (never guesses)", () => {
  const map = { "1001": { sku: "LNY01-BLACK", available: true } };
  assert.equal(resolveVariantFromMap(map, "9999999999"), null);
});

test("resolveVariantFromMap: returns null for a malformed numeric id, even if present as a key some other way", () => {
  const map = { "0": { sku: "x", available: true } };
  assert.equal(resolveVariantFromMap(map, "0"), null);
  assert.equal(resolveVariantFromMap(map, "not-numeric"), null);
});

test("resolveVariantFromMap: returns null for a malformed entry shape (missing/wrong-typed sku or available)", () => {
  assert.equal(resolveVariantFromMap({ "1001": { sku: "x" } }, "1001"), null);
  assert.equal(resolveVariantFromMap({ "1001": { available: true } }, "1001"), null);
  assert.equal(resolveVariantFromMap({ "1001": null }, "1001"), null);
  assert.equal(resolveVariantFromMap({ "1001": "not-an-object" }, "1001"), null);
});

test("resolveVariantFromMap: returns null for a non-object map", () => {
  assert.equal(resolveVariantFromMap(null, "1001"), null);
  assert.equal(resolveVariantFromMap(undefined, "1001"), null);
});

// --- readVariantMap (Task 2B.2) ---------------------------------------------------

test("readVariantMap: Task 2B.3 — absent / undefined / null / empty / whitespace-only fails closed (present:false, valid:false)", () => {
  // Missing metadata is NOT a legacy single-variant bypass. The real Liquid always
  // emits at least `data-variant-map="{}"`, so a genuinely absent attribute means a
  // broken/stale asset and must fail closed.
  assert.deepEqual(readVariantMap(undefined), { present: false, valid: false, entries: [] });
  assert.deepEqual(readVariantMap(null), { present: false, valid: false, entries: [] });
  assert.deepEqual(readVariantMap(""), { present: false, valid: false, entries: [] });
  assert.deepEqual(readVariantMap("   "), { present: false, valid: false, entries: [] });
  assert.deepEqual(readVariantMap("\t\n "), { present: false, valid: false, entries: [] });
  assert.deepEqual(readVariantMap(42), { present: false, valid: false, entries: [] });
});

test("readVariantMap: a well-formed multi-variant map -> present:true, valid:true, all entries", () => {
  const result = readVariantMap('{"1001":{"sku":"LNY01-A","available":true},"1002":{"sku":"LNY01-B","available":false}}');
  assert.equal(result.present, true);
  assert.equal(result.valid, true);
  assert.deepEqual(result.entries, [
    { id: "1001", sku: "LNY01-A", available: true },
    { id: "1002", sku: "LNY01-B", available: false },
  ]);
});

test("readVariantMap: malformed JSON -> present:true, valid:false, no entries (never throws)", () => {
  assert.deepEqual(readVariantMap('{"1001":{"sku":"LNY01-A"'), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap("not json at all"), { present: true, valid: false, entries: [] });
});

test("readVariantMap: an array or a JSON primitive -> present:true, valid:false", () => {
  assert.deepEqual(readVariantMap("[1,2,3]"), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap("null"), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap('"a string"'), { present: true, valid: false, entries: [] });
});

test("readVariantMap: an empty object -> present:true, valid:true, no entries", () => {
  assert.deepEqual(readVariantMap("{}"), { present: true, valid: true, entries: [] });
});

test("readVariantMap: one invalid variant-id key makes the WHOLE map invalid (never partially trusted)", () => {
  assert.deepEqual(
    readVariantMap('{"1001":{"sku":"A","available":true},"not-a-number":{"sku":"B","available":true}}'),
    { present: true, valid: false, entries: [] },
  );
  assert.deepEqual(readVariantMap('{"0":{"sku":"A","available":true}}'), { present: true, valid: false, entries: [] });
});

test("readVariantMap: a null, blank, or non-string SKU on any entry makes the whole map invalid (inconsistent metadata)", () => {
  assert.deepEqual(readVariantMap('{"1001":{"sku":null,"available":true}}'), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap('{"1001":{"sku":"","available":true}}'), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap('{"1001":{"sku":123,"available":true}}'), { present: true, valid: false, entries: [] });
});

test("readVariantMap: a non-boolean `available` on any entry makes the whole map invalid", () => {
  assert.deepEqual(readVariantMap('{"1001":{"sku":"A","available":"yes"}}'), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap('{"1001":{"sku":"A"}}'), { present: true, valid: false, entries: [] });
});
