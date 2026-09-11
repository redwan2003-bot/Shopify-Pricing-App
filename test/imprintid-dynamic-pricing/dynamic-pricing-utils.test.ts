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
  parseShopifyNumericId,
  checkResponseIdentity,
  cartLineAttributesFromSignedPricing,
  CART_PRICING_ATTR_NAMES,
  readSignedV2Quote,
  isSignedV2QuoteExpired,
  signedV2QuoteAttributes,
  V2_QUOTE_TTL_SECONDS,
  V2_PAYLOAD_FIELDS,
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

test("readVariantMap: a null or non-string SKU on any entry makes the whole map invalid (inconsistent metadata)", () => {
  assert.deepEqual(readVariantMap('{"1001":{"sku":null,"available":true}}'), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap('{"1001":{"sku":123,"available":true}}'), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap('{"1001":{"sku":{},"available":true}}'), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap('{"1001":{"sku":true,"available":true}}'), { present: true, valid: false, entries: [] });
});

test("readVariantMap: Task 4A — an EMPTY-STRING SKU is valid (a Shopify variant with no SKU); a blank SKU never authorizes pricing on its own", () => {
  assert.deepEqual(readVariantMap('{"1001":{"sku":"","available":true}}'), {
    present: true,
    valid: true,
    entries: [{ id: "1001", sku: "", available: true }],
  });
  // Mixed: one real SKU, one blank — still a wholly consistent map.
  assert.deepEqual(readVariantMap('{"1001":{"sku":"","available":true},"1002":{"sku":"LNY01","available":false}}'), {
    present: true,
    valid: true,
    entries: [
      { id: "1001", sku: "", available: true },
      { id: "1002", sku: "LNY01", available: false },
    ],
  });
});

test("readVariantMap: a non-boolean `available` on any entry makes the whole map invalid", () => {
  assert.deepEqual(readVariantMap('{"1001":{"sku":"A","available":"yes"}}'), { present: true, valid: false, entries: [] });
  assert.deepEqual(readVariantMap('{"1001":{"sku":"A"}}'), { present: true, valid: false, entries: [] });
});

// --- parseShopifyNumericId (Task 4A) ---------------------------------------------

test("parseShopifyNumericId: accepts a bare positive decimal id, returned unchanged as a string", () => {
  assert.equal(parseShopifyNumericId("1"), "1");
  assert.equal(parseShopifyNumericId("9442404663548"), "9442404663548");
});

test("parseShopifyNumericId: an id far beyond Number.MAX_SAFE_INTEGER is returned intact (never via Number())", () => {
  const huge = "99999999999999999999999999";
  assert.equal(parseShopifyNumericId(huge), huge);
});

test("parseShopifyNumericId: rejects missing, blank, whitespace, zero, leading-zero, negative, decimal, and scientific notation", () => {
  assert.equal(parseShopifyNumericId(undefined), null);
  assert.equal(parseShopifyNumericId(null), null);
  assert.equal(parseShopifyNumericId(""), null);
  assert.equal(parseShopifyNumericId("   "), null);
  assert.equal(parseShopifyNumericId("0"), null);
  assert.equal(parseShopifyNumericId("0123"), null);
  assert.equal(parseShopifyNumericId("-123"), null);
  assert.equal(parseShopifyNumericId("12.3"), null);
  assert.equal(parseShopifyNumericId("1e3"), null);
});

test("parseShopifyNumericId: rejects GID-shaped, object, array, boolean, number, and mixed-character values", () => {
  assert.equal(parseShopifyNumericId("gid://shopify/Product/9442404663548"), null);
  assert.equal(parseShopifyNumericId("gid://shopify/ProductVariant/1"), null);
  assert.equal(parseShopifyNumericId({} as unknown), null);
  assert.equal(parseShopifyNumericId([] as unknown), null);
  assert.equal(parseShopifyNumericId(true as unknown), null);
  assert.equal(parseShopifyNumericId(12345 as unknown), null);
  assert.equal(parseShopifyNumericId("123abc"), null);
  assert.equal(parseShopifyNumericId(" 123 "), null);
});

// --- checkResponseIdentity (Task 4A.1 §3) --------------------------------------

const OK_CTX = {
  requestProductId: "9442404663548",
  requestVariantId: "51028263796988",
  currentProductId: "9442404663548",
  currentVariantId: "51028263796988",
  selectedVariantSkuBlank: false,
};
const OK_IDENTITY = { shopifyProductId: "9442404663548", shopifyVariantId: "51028263796988", resolutionSource: "sku" };

test("checkResponseIdentity: a well-formed, matching identity passes", () => {
  assert.equal(checkResponseIdentity(OK_IDENTITY, OK_CTX), true);
  assert.equal(checkResponseIdentity({ ...OK_IDENTITY, resolutionSource: "product_override" }, OK_CTX), true);
});

test("checkResponseIdentity: absent / null / non-object identity is rejected", () => {
  assert.equal(checkResponseIdentity(undefined, OK_CTX), false);
  assert.equal(checkResponseIdentity(null, OK_CTX), false);
  assert.equal(checkResponseIdentity("id", OK_CTX), false);
  assert.equal(checkResponseIdentity(123, OK_CTX), false);
});

test("checkResponseIdentity: a missing or empty required property is rejected", () => {
  assert.equal(checkResponseIdentity({ shopifyVariantId: OK_IDENTITY.shopifyVariantId, resolutionSource: "sku" }, OK_CTX), false);
  assert.equal(checkResponseIdentity({ shopifyProductId: OK_IDENTITY.shopifyProductId, resolutionSource: "sku" }, OK_CTX), false);
  assert.equal(checkResponseIdentity({ ...OK_IDENTITY, shopifyProductId: "" }, OK_CTX), false);
});

test("checkResponseIdentity: a missing or unsupported resolutionSource is rejected", () => {
  assert.equal(checkResponseIdentity({ shopifyProductId: OK_IDENTITY.shopifyProductId, shopifyVariantId: OK_IDENTITY.shopifyVariantId }, OK_CTX), false);
  assert.equal(checkResponseIdentity({ ...OK_IDENTITY, resolutionSource: "default" }, OK_CTX), false);
  assert.equal(checkResponseIdentity({ ...OK_IDENTITY, resolutionSource: "" }, OK_CTX), false);
  assert.equal(checkResponseIdentity({ ...OK_IDENTITY, resolutionSource: null }, OK_CTX), false);
});

test("checkResponseIdentity: a mismatch with the request or the current selection is rejected", () => {
  assert.equal(checkResponseIdentity({ ...OK_IDENTITY, shopifyVariantId: "999" }, OK_CTX), false); // != request/current
  assert.equal(checkResponseIdentity(OK_IDENTITY, { ...OK_CTX, currentVariantId: "999" }), false); // moved on
  assert.equal(checkResponseIdentity(OK_IDENTITY, { ...OK_CTX, requestProductId: "999" }), false);
});

test("checkResponseIdentity: a blank selected SKU accepts ONLY product_override", () => {
  const blankCtx = { ...OK_CTX, selectedVariantSkuBlank: true };
  assert.equal(checkResponseIdentity({ ...OK_IDENTITY, resolutionSource: "sku" }, blankCtx), false);
  assert.equal(checkResponseIdentity({ ...OK_IDENTITY, resolutionSource: "product_override" }, blankCtx), true);
});

// ---------------------------------------------------------------------------
// Task 5B.1 — cartLineAttributesFromSignedPricing
// ---------------------------------------------------------------------------

test("cartLineAttributesFromSignedPricing: a v1 signed payload maps to exactly the three legacy attributes", () => {
  const props = cartLineAttributesFromSignedPricing({ version: 1, payload: '{"v":1}', signature: "abc" });
  assert.deepEqual(props, {
    [CART_PRICING_ATTR_NAMES.version]: "1",
    [CART_PRICING_ATTR_NAMES.payload]: '{"v":1}',
    [CART_PRICING_ATTR_NAMES.signature]: "abc",
  });
  assert.ok(!(CART_PRICING_ATTR_NAMES.config in props));
});

test("cartLineAttributesFromSignedPricing: a v2 payload also carries the normalized config attribute", () => {
  const props = cartLineAttributesFromSignedPricing({ version: 2, payload: '{"v":2}', signature: "sig", config: '{"a":1}' });
  assert.ok(props);
  assert.equal(props?.[CART_PRICING_ATTR_NAMES.version], "2");
  assert.equal(props?.[CART_PRICING_ATTR_NAMES.config], '{"a":1}');
});

test("cartLineAttributesFromSignedPricing: fails closed (null) for missing/invalid input", () => {
  assert.equal(cartLineAttributesFromSignedPricing(null), null);
  assert.equal(cartLineAttributesFromSignedPricing({}), null);
  assert.equal(cartLineAttributesFromSignedPricing({ version: 3, payload: "p", signature: "s" }), null);
  assert.equal(cartLineAttributesFromSignedPricing({ version: 1, payload: "", signature: "s" }), null);
  assert.equal(cartLineAttributesFromSignedPricing({ version: 1, payload: "p", signature: 123 }), null);
  // v2 without a config string
  assert.equal(cartLineAttributesFromSignedPricing({ version: 2, payload: "p", signature: "s" }), null);
});

test("cartLineAttributesFromSignedPricing: fails closed when an attribute exceeds its byte limit", () => {
  const huge = "x".repeat(5000);
  assert.equal(cartLineAttributesFromSignedPricing({ version: 1, payload: huge, signature: "s" }), null);
  const bigConfig = "y".repeat(9000);
  assert.equal(cartLineAttributesFromSignedPricing({ version: 2, payload: "{}", signature: "s", config: bigConfig }), null);
});

// ---------------------------------------------------------------------------
// Task 5B.3A — v2-only signed-quote reading (browser side, opaque)
// ---------------------------------------------------------------------------

function v2Payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    installBinding: "ib",
    productGid: "gid://shopify/Product/9442404663548",
    variantGid: "gid://shopify/ProductVariant/51028263796988",
    quantity: 100,
    currency: "USD",
    baseUnitPriceCents: 137,
    perUnitSurchargeCents: 0,
    flatSurchargeCents: 0,
    lineTotalCents: 13700,
    adjustmentVariantGid: "gid://shopify/ProductVariant/999",
    profileRef: "prof",
    profileRevision: 1,
    policyRevision: 1,
    configDigest: "sha256:abc",
    quoteId: "q1",
    issuedAtServer: 1_000_000,
    ...over,
  };
}
function v2Quote(over: Record<string, unknown> = {}, envelopeOver: Record<string, unknown> = {}) {
  return { version: 2, payload: JSON.stringify(v2Payload(over)), signature: "deadbeef", config: '{"quantity":100}', ...envelopeOver };
}

test("readSignedV2Quote: a complete v2 envelope parses", () => {
  const r = readSignedV2Quote(v2Quote());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.payload.quantity, 100);
});

test("readSignedV2Quote: V2_PAYLOAD_FIELDS has exactly 17 keys and matches the payload we build", () => {
  assert.equal(V2_PAYLOAD_FIELDS.length, 17);
  assert.deepEqual([...V2_PAYLOAD_FIELDS].sort(), Object.keys(v2Payload()).sort());
});

test("readSignedV2Quote: fails closed for v1, missing attrs, unknown/missing payload fields, bad types, oversize", () => {
  assert.equal(readSignedV2Quote({ version: 1, payload: "{}", signature: "s", config: "{}" }).ok, false);
  assert.equal(readSignedV2Quote(v2Quote({}, { signature: "" })).ok, false);
  assert.equal(readSignedV2Quote(v2Quote({}, { config: "" })).ok, false);
  // extra field
  assert.equal(readSignedV2Quote({ version: 2, payload: JSON.stringify({ ...v2Payload(), extra: 1 }), signature: "s", config: "{}" }).ok, false);
  // missing field
  const missing = v2Payload();
  delete missing.quoteId;
  assert.equal(readSignedV2Quote({ version: 2, payload: JSON.stringify(missing), signature: "s", config: "{}" }).ok, false);
  // wrong type
  assert.equal(readSignedV2Quote(v2Quote({ quantity: "100" })).ok, false);
  assert.equal(readSignedV2Quote(v2Quote({ baseUnitPriceCents: -1 })).ok, false);
  assert.equal(readSignedV2Quote(v2Quote({ variantGid: "" })).ok, false);
  // oversize payload
  assert.equal(readSignedV2Quote(v2Quote({ quoteId: "q".repeat(5000) })).ok, false);
});

test("isSignedV2QuoteExpired: derived from issuedAtServer + V2_QUOTE_TTL_SECONDS", () => {
  const p = v2Payload({ issuedAtServer: 1_000_000 });
  assert.equal(isSignedV2QuoteExpired(p, 1_000_000 + V2_QUOTE_TTL_SECONDS - 1), false);
  assert.equal(isSignedV2QuoteExpired(p, 1_000_000 + V2_QUOTE_TTL_SECONDS + 1), true);
  assert.equal(isSignedV2QuoteExpired({ issuedAtServer: "x" }, 0), true);
});

test("signedV2QuoteAttributes: returns exactly the four v2 attributes, and NEVER a v1 envelope", () => {
  const props = signedV2QuoteAttributes(v2Quote());
  assert.deepEqual(Object.keys(props!).sort(), [
    CART_PRICING_ATTR_NAMES.config,
    CART_PRICING_ATTR_NAMES.payload,
    CART_PRICING_ATTR_NAMES.signature,
    CART_PRICING_ATTR_NAMES.version,
  ].sort());
  assert.equal(props![CART_PRICING_ATTR_NAMES.version], "2");
  // v1 → null (browser never submits v1 attributes on the v2 path)
  assert.equal(signedV2QuoteAttributes({ version: 1, payload: '{"v":1}', signature: "s", config: "{}" }), null);
  assert.equal(signedV2QuoteAttributes(null), null);
});
