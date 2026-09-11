/**
 * Pure helpers shared by dynamic-pricing.js — kept in their own module, with no
 * `window`/`document` references, so they can be loaded and unit-tested directly
 * under plain Node (see dynamic-pricing-utils.test.ts) as well as in the browser.
 * `formatMoney` only ever divides by 100 for display — see dynamic-pricing.js's
 * top-of-file comment for why that's not "pricing arithmetic."
 */

export function formatMoney(cents, locale) {
  if (typeof cents !== "number" || !isFinite(cents)) return "—";
  try {
    return new Intl.NumberFormat(locale || "en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  } catch (err) {
    return "$" + (cents / 100).toFixed(2);
  }
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Buckets one ALREADY-RESOLVED price (in cents, or null) into a display category —
 * pure formatting, zero pricing logic. This does not decide *which* of several
 * possible prices applies to an option; that precedence (`OptionValue.
 * priceAdjustmentCents`, falling back to the enclosing group's
 * `categoryPriceAdjustmentCents`) is resolved entirely server-side, once, by
 * `app/lib/pricing/calculator.ts#resolveOptionValuePrice` — the exact same function
 * both `calculatePrice()` and the catalog API (`app/lib/pricing-api/catalog.ts`) call.
 * The storefront only ever receives the already-resolved `resolvedPriceCents` (see
 * `PricingCatalogOptionValue`) and buckets that single number for display; it never
 * re-derives which source won.
 *
 * Returns a discriminated result rather than a raw number so the caller can render
 * "Included" for a confirmed $0 differently from "price unavailable" for a genuinely
 * unset price — the same null-vs-zero distinction this system observes everywhere else
 * (see prisma/schema.prisma's OptionValue/OptionGroup doc comments).
 */
export function classifyResolvedPriceCents(resolvedPriceCents) {
  if (resolvedPriceCents === null || resolvedPriceCents === undefined) {
    return { kind: "unavailable" };
  }
  if (resolvedPriceCents === 0) {
    return { kind: "included" };
  }
  return { kind: "priced", cents: resolvedPriceCents };
}

// --- Variant synchronization helpers (Task 2B) -----------------------------------
//
// These are pure, DOM-free parsing/lookup functions shared by dynamic-pricing.js —
// kept separate for the same reason as the helpers above: they're unit-testable under
// plain Node, and keeping them pure means dynamic-pricing.js's own code stays focused
// on orchestration (event wiring, state transitions), not string/JSON parsing.
//
// None of this ever touches pricing. It only ever answers "which real Shopify variant
// (by numeric id) is the customer currently looking at, and what SKU/availability does
// the page's own trusted variant map say that id has" — the actual price for that
// variant+configuration always comes from the server (see dynamic-pricing.js's
// top-of-file comment and app/lib/pricing-api/storefront-handler.ts).

const PRODUCT_VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/([1-9]\d*)$/;
const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/([1-9]\d*)$/;
const POSITIVE_DIGIT_STRING_PATTERN = /^[1-9]\d*$/;

/**
 * Parses a Shopify ProductVariant GID (`gid://shopify/ProductVariant/<positive-numeric-id>`)
 * and returns just the numeric id, as a string — never via `Number(...)` or `parseInt(...)`,
 * since Shopify's real variant ids can exceed `Number.MAX_SAFE_INTEGER` precision and must
 * be carried as opaque digit strings everywhere (the same convention
 * `validateAdjustmentVariantGid` follows server-side — see
 * app/lib/pricing-api/storefront-handler.ts). Returns `null` for anything that isn't
 * exactly that GID shape: wrong resource type, missing/leading-zero/non-digit id, or a
 * non-string input — this is intentionally the *only* way a variant id ever enters this
 * block's state from an event payload, so a malformed or unexpected GID simply fails
 * closed rather than being partially trusted.
 */
export function parseProductVariantGid(value) {
  if (typeof value !== "string") return null;
  const match = PRODUCT_VARIANT_GID_PATTERN.exec(value);
  return match ? match[1] : null;
}

/**
 * Same shape of parsing as `parseProductVariantGid`, for a Shopify Product GID
 * (`gid://shopify/Product/<positive-numeric-id>`) — used only to validate the block's
 * own constructed `data-product-gid` value defensively; the actual product-match check
 * against an incoming `shopify:product:select` event compares full GID strings directly
 * (see dynamic-pricing.js#handleProductSelect), since both sides are already in the same
 * GID form and no numeric extraction is needed for that comparison.
 */
export function parseProductGid(value) {
  if (typeof value !== "string") return null;
  const match = PRODUCT_GID_PATTERN.exec(value);
  return match ? match[1] : null;
}

/** True iff `value` is a string of only digits, with no leading zero (unless the value
 * is itself impossible for a Shopify id — Shopify ids are always >= 1) — i.e. exactly
 * the numeric-id form this file carries everywhere instead of a JS `number`. Used to
 * validate a raw `input[name="id"]` DOM value before trusting it (see
 * dynamic-pricing.js's hidden-input cross-check) — a non-numeric value (e.g. the input
 * hasn't been populated yet, or belongs to something else entirely) is never treated as
 * a usable variant id. */
export function isPositiveDigitString(value) {
  return typeof value === "string" && POSITIVE_DIGIT_STRING_PATTERN.test(value);
}

/**
 * Parses the block's `data-variant-map` attribute value (a JSON object keyed by numeric
 * variant id string, each value `{ sku, available }` — built server-side by Liquid, see
 * dynamic-pricing.liquid) into a plain object. Fails closed to `{}` (never throws, never
 * returns anything but a plain object) on missing/malformed JSON, so a broken or absent
 * variant map simply means no variant ever resolves from it — the block behaves as if it
 * knows about no variants beyond whatever was already trusted at construction, rather
 * than crashing or trusting unparsed data.
 */
export function parseVariantMap(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed;
}

/**
 * Looks up one numeric variant id in a parsed variant map, returning its `{ sku,
 * available }` entry or `null` if the id is missing, malformed, or the map has no entry
 * shaped as expected. This is the *only* place SKU/availability are ever read for a
 * variant a customer has selected — never from the event payload's own `variant.title`
 * or similar, since the variant map is this page's one server-rendered, trusted source
 * for that data (see dynamic-pricing.liquid's variant map comment).
 */
export function resolveVariantFromMap(variantMap, numericId) {
  if (!isPositiveDigitString(numericId)) return null;
  if (typeof variantMap !== "object" || variantMap === null) return null;
  const entry = variantMap[numericId];
  if (typeof entry !== "object" || entry === null) return null;
  if (typeof entry.sku !== "string" || typeof entry.available !== "boolean") return null;
  return entry;
}

// --- Task 2B.2 / 2B.3: multi-variant fail-closed readiness -----------------------
//
// `readVariantMap` is the strict, whole-map counterpart to `parseVariantMap` +
// `resolveVariantFromMap` (which validate one entry at a time and silently skip a bad
// one). Task 2B.2 needs to know, up front, whether the block was handed CONSISTENT
// variant metadata — because a multi-variant product whose section can't be resolved
// must fail closed rather than keep pricing the initially rendered variant while the
// customer picks Red/Blue.
//
// Task 2B.3: MISSING metadata is invalid, not a legacy "single-implicit-variant"
// bypass. An absent / undefined / null / empty / whitespace-only `data-variant-map`
// returns `{ present:false, valid:false, entries:[] }` so `canUseDynamicPricing()`
// fails closed. The block must never infer a single-variant product from the *absence*
// of a variant map — the real Liquid always emits at least `data-variant-map="{}"`, so
// a genuinely missing attribute means a broken/stale asset, not a preview.
//
// Distinctions it draws that the per-entry helpers can't:
//   - `present`: was a non-empty `data-variant-map` attribute supplied at all?
//   - `valid`:   was it supplied AND did it parse to a plain object where EVERY key is
//                a positive-digit variant id and EVERY value is a well-formed
//                `{ sku:<non-empty string>, available:<boolean> }`? One malformed
//                key/entry (a null/blank SKU, a non-boolean `available`, a bad id), a
//                non-object, OR nothing at all makes it `valid:false` — "malformed
//                metadata must never be interpreted as a safe single-variant product."

/**
 * @param {unknown} raw - the raw `data-variant-map` attribute value (or `undefined`).
 * @returns {{ present: boolean, valid: boolean, entries: Array<{id: string, sku: string, available: boolean}> }}
 *   `present` — a non-empty attribute string was supplied.
 *   `valid`   — a non-empty attribute string was supplied AND it parsed to a plain
 *               object with every key/entry well-formed. Absent/blank ⇒ `false`
 *               (Task 2B.3 — missing metadata fails closed).
 *   `entries` — the validated `{ id, sku, available }` list (empty unless `valid` and
 *               at least one entry exists).
 * Never throws.
 */
export function readVariantMap(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { present: false, valid: false, entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, valid: false, entries: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { present: true, valid: false, entries: [] };
  }
  const entries = [];
  for (const key of Object.keys(parsed)) {
    if (!isPositiveDigitString(key)) return { present: true, valid: false, entries: [] };
    const entry = parsed[key];
    if (typeof entry !== "object" || entry === null) return { present: true, valid: false, entries: [] };
    // Task 4A: SKU identity is separate from variant identity. The SKU may be a real
    // value OR an empty string (a Shopify variant with no SKU — normalized from `nil`
    // to `""` in the Liquid). It must still be a STRING — a number, object, array,
    // boolean, or (a stale) `null` is malformed metadata and fails the whole map
    // closed. A blank SKU never independently authorizes pricing (the server requires
    // an active ProductPricingOverride for it — see product-resolver.ts).
    if (typeof entry.sku !== "string") return { present: true, valid: false, entries: [] };
    if (typeof entry.available !== "boolean") return { present: true, valid: false, entries: [] };
    entries.push({ id: key, sku: entry.sku, available: entry.available });
  }
  return { present: true, valid: true, entries };
}

/**
 * Task 4A — the storefront-side mirror of `app/lib/pricing-api/product-resolver.ts`'s
 * `parseShopifyNumericId`. Accepts ONLY a bare positive decimal digit string; rejects
 * missing/blank/zero/leading-zero/negative/decimal/scientific-notation/GID-shaped/
 * object/array/number/boolean values. Returns the ORIGINAL string with NO numeric
 * conversion — Shopify ids can exceed `Number.MAX_SAFE_INTEGER`.
 */
export function parseShopifyNumericId(value) {
  if (typeof value !== "string") return null;
  if (!POSITIVE_DIGIT_STRING_PATTERN.test(value)) return null;
  return value;
}

/** The only resolution sources a storefront response may carry (Task 4A.1 §3). */
export const ALLOWED_RESOLUTION_SOURCES = ["product_override", "sku"];

/**
 * Task 4A.1 §3 — validates a pricing/catalog response's canonical `identity`. Returns
 * `true` ONLY when it is a plain object with:
 *   - a non-empty string `shopifyProductId` and `shopifyVariantId`;
 *   - a `resolutionSource` of exactly `"product_override"` or `"sku"`;
 *   - `shopifyProductId` / `shopifyVariantId` equal to BOTH what this request asked for
 *     (`requestProductId` / `requestVariantId`) AND what is currently selected
 *     (`currentProductId` / `currentVariantId`);
 *   - `resolutionSource === "product_override"` whenever the currently selected
 *     variant's SKU is blank (`selectedVariantSkuBlank`).
 * Absent / null / malformed / missing-property / mismatched / unsupported-source all
 * return `false` — the caller must then fail closed (clear the quote, disable Add to
 * Cart, show a safe error, never render, never submit to /cart/add.js).
 */
export function checkResponseIdentity(identity, ctx) {
  if (!identity || typeof identity !== "object") return false;
  if (typeof identity.shopifyProductId !== "string" || identity.shopifyProductId.length === 0) return false;
  if (typeof identity.shopifyVariantId !== "string" || identity.shopifyVariantId.length === 0) return false;
  if (ALLOWED_RESOLUTION_SOURCES.indexOf(identity.resolutionSource) === -1) return false;
  if (identity.shopifyProductId !== ctx.requestProductId) return false;
  if (identity.shopifyVariantId !== ctx.requestVariantId) return false;
  if (identity.shopifyProductId !== ctx.currentProductId) return false;
  if (identity.shopifyVariantId !== ctx.currentVariantId) return false;
  if (ctx.selectedVariantSkuBlank && identity.resolutionSource !== "product_override") return false;
  return true;
}

/**
 * Task 5B.1 — the private cart-line property names for the signed quote. Underscore
 * prefix keeps them hidden from the storefront line-item property display. Must match
 * `app/lib/pricing-api/cart-pricing-contract.ts#CART_PRICING_ATTRS` and the Function's
 * input query.
 */
export const CART_PRICING_ATTR_NAMES = {
  version: "_imprintid_pricing_version",
  payload: "_imprintid_pricing_payload",
  signature: "_imprintid_pricing_signature",
  config: "_imprintid_pricing_config",
};

/** Conservative byte ceilings; a payload/config over these is treated as a stale/hostile
 * response and no attributes are produced (fail closed). Mirrors the server limits. */
export const CART_PRICING_ATTR_LIMITS = { maxPayloadBytes: 4096, maxConfigBytes: 8192 };

function utf8ByteLength(value) {
  if (typeof value !== "string") return Infinity;
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
  return unescape(encodeURIComponent(value)).length;
}

/**
 * Task 5B.1 — builds the `properties` object for `/cart/add.js` from a signed pricing
 * payload the server returned. Handles envelope v1 (`{version:1, payload, signature}`)
 * and v2 (`{version:2, payload, signature, config}`). Returns `null` — and the caller
 * MUST then abort the add (fail closed) — when:
 *   - `cartPricing` is missing / not an object;
 *   - `version` is not 1 or 2;
 *   - `payload` / `signature` are missing or not strings;
 *   - a v2 response has no string `config`;
 *   - any attribute exceeds its byte limit.
 * This does not weaken any Task 2B / 4A quote-ownership guard — those still gate whether
 * `cartPricing` is set at all; this only serializes an already-approved quote.
 *
 * @param {unknown} cartPricing
 * @returns {{ [key: string]: string } | null}
 */
export function cartLineAttributesFromSignedPricing(cartPricing) {
  if (!cartPricing || typeof cartPricing !== "object") return null;

  const version = Number(cartPricing.version);
  if (version !== 1 && version !== 2) return null;
  if (typeof cartPricing.payload !== "string" || cartPricing.payload.length === 0) return null;
  if (typeof cartPricing.signature !== "string" || cartPricing.signature.length === 0) return null;
  if (utf8ByteLength(cartPricing.payload) > CART_PRICING_ATTR_LIMITS.maxPayloadBytes) return null;

  /** @type {{ [key: string]: string }} */
  const props = {};
  props[CART_PRICING_ATTR_NAMES.version] = String(version);
  props[CART_PRICING_ATTR_NAMES.payload] = cartPricing.payload;
  props[CART_PRICING_ATTR_NAMES.signature] = cartPricing.signature;

  if (version === 2) {
    if (typeof cartPricing.config !== "string" || cartPricing.config.length === 0) return null;
    if (utf8ByteLength(cartPricing.config) > CART_PRICING_ATTR_LIMITS.maxConfigBytes) return null;
    props[CART_PRICING_ATTR_NAMES.config] = cartPricing.config;
  }

  return props;
}

// --- Task 5B.3A: authoritative v2 quote handling (browser, opaque) -----------------
//
// The browser NEVER constructs, edits, merges, or re-signs a v2 payload. It only:
//   1. validates the SHAPE of the v2 quote the server returned (defence against a
//      stale / truncated / tampered response), and
//   2. reads a few already-signed fields (`variantGid`, `productGid`, `quantity`,
//      `issuedAtServer`) to confirm the quote still OWNS the current selection and has
//      not expired, before enabling / submitting Add to Cart.

/** Advisory quote lifetime, seconds. Mirrors
 * `app/lib/pricing-api/cart-signature.ts#V2_QUOTE_TTL_SECONDS`. There is no `expiresAt`
 * FIELD — expiry is derived from the signed `issuedAtServer` and only ever checked
 * where a real clock is legitimate (here, the browser — never a Shopify Function). */
export const V2_QUOTE_TTL_SECONDS = 30 * 60;

/** The exact key set of a v2 payload. Mirrors
 * `app/lib/pricing-api/cart-pricing-contract.ts#V2_PAYLOAD_KEYS`. */
export const V2_PAYLOAD_FIELDS = [
  "v",
  "installBinding",
  "productGid",
  "variantGid",
  "quantity",
  "currency",
  "baseUnitPriceCents",
  "perUnitSurchargeCents",
  "flatSurchargeCents",
  "lineTotalCents",
  "adjustmentVariantGid",
  "profileRef",
  "profileRevision",
  "policyRevision",
  "configDigest",
  "quoteId",
  "issuedAtServer",
];

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isNonNegSafeInt(v) {
  return typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Validates a v2 signed-quote envelope the server returned. Returns
 * `{ ok: true, payload }` only when EVERY expected attribute + payload field is present
 * and well-typed; `{ ok: false, reason }` otherwise (the caller must then treat the
 * quote as NOT cart-ready). `payload` is the parsed object — read-only, never mutated.
 *
 * @param {unknown} cartPricing
 * @returns {{ ok: true, payload: Record<string, any> } | { ok: false, reason: string }}
 */
export function readSignedV2Quote(cartPricing) {
  if (!cartPricing || typeof cartPricing !== "object") return { ok: false, reason: "missing" };
  if (Number(cartPricing.version) !== 2) return { ok: false, reason: "not_v2" };
  if (!isNonEmptyString(cartPricing.payload)) return { ok: false, reason: "missing" };
  if (!isNonEmptyString(cartPricing.signature)) return { ok: false, reason: "missing" };
  if (!isNonEmptyString(cartPricing.config)) return { ok: false, reason: "missing" };
  if (utf8ByteLength(cartPricing.payload) > CART_PRICING_ATTR_LIMITS.maxPayloadBytes) return { ok: false, reason: "too_large" };
  if (utf8ByteLength(cartPricing.config) > CART_PRICING_ATTR_LIMITS.maxConfigBytes) return { ok: false, reason: "too_large" };

  var parsed;
  try {
    parsed = JSON.parse(cartPricing.payload);
  } catch (e) {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "malformed" };

  var keys = Object.keys(parsed);
  if (keys.length !== V2_PAYLOAD_FIELDS.length) return { ok: false, reason: "unknown_fields" };
  for (var i = 0; i < V2_PAYLOAD_FIELDS.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(parsed, V2_PAYLOAD_FIELDS[i])) return { ok: false, reason: "missing_field" };
  }

  if (parsed.v !== 2) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.installBinding)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.productGid)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.variantGid)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.quantity) || parsed.quantity < 1) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.currency)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.baseUnitPriceCents)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.perUnitSurchargeCents)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.flatSurchargeCents)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.lineTotalCents)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.adjustmentVariantGid)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.profileRef)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.profileRevision)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.policyRevision)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.configDigest)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.quoteId)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.issuedAtServer)) return { ok: false, reason: "malformed" };

  return { ok: true, payload: parsed };
}

/** Whether a parsed v2 payload's advisory lifetime has elapsed (derived from the signed
 * `issuedAtServer` + `V2_QUOTE_TTL_SECONDS`). `nowSeconds` is injected for testability. */
export function isSignedV2QuoteExpired(payload, nowSeconds) {
  if (!payload || typeof payload.issuedAtServer !== "number") return true;
  return nowSeconds > payload.issuedAtServer + V2_QUOTE_TTL_SECONDS;
}

/**
 * Builds the `/cart/add.js` `properties` object for a v2 quote — v2 ONLY. Returns the
 * four private attributes UNCHANGED, or `null` (fail closed) for anything that isn't a
 * complete v2 envelope. A v1 envelope returns `null` — the browser never submits v1
 * attributes on the v2 path (Task 5B.3A).
 *
 * @param {unknown} cartPricing
 * @returns {{ [key: string]: string } | null}
 */
export function signedV2QuoteAttributes(cartPricing) {
  var check = readSignedV2Quote(cartPricing);
  if (!check.ok) return null;
  var props = {};
  props[CART_PRICING_ATTR_NAMES.version] = "2";
  props[CART_PRICING_ATTR_NAMES.payload] = cartPricing.payload;
  props[CART_PRICING_ATTR_NAMES.signature] = cartPricing.signature;
  props[CART_PRICING_ATTR_NAMES.config] = cartPricing.config;
  return props;
}

/**
 * Task 5B.3A — the legacy v1 envelope serializer for the NON-PRODUCTION transition
 * window only. Returns the three v1 attributes, or `null` unless the envelope `version`
 * is exactly `1` AND its payload genuinely parses to a v1 body (`{"v":1,…}`) — so a
 * `version:1` envelope carrying a v2-shaped payload (a downgrade attempt) is rejected,
 * never re-labelled and submitted as v1.
 *
 * @param {unknown} cartPricing
 * @returns {{ [key: string]: string } | null}
 */
export function legacyV1QuoteAttributes(cartPricing) {
  if (!cartPricing || typeof cartPricing !== "object") return null;
  if (Number(cartPricing.version) !== 1) return null;
  if (typeof cartPricing.payload !== "string") return null;
  var parsed;
  try {
    parsed = JSON.parse(cartPricing.payload);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
  return cartLineAttributesFromSignedPricing(cartPricing);
}
