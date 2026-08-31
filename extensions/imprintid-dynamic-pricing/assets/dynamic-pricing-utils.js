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
    if (typeof entry.sku !== "string" || entry.sku.length === 0) return { present: true, valid: false, entries: [] };
    if (typeof entry.available !== "boolean") return { present: true, valid: false, entries: [] };
    entries.push({ id: key, sku: entry.sku, available: entry.available });
  }
  return { present: true, valid: true, entries };
}
