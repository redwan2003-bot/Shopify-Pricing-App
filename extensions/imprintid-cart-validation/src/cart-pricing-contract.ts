/**
 * THE SINGLE SOURCE OF TRUTH for the ImprintID cart-pricing contract — property names,
 * envelope versions, enforcement modes, parsing limits, canonical field order, monetary
 * invariants, and customer-safe reject codes.
 *
 * Task 5B.1. Consumed by the application signing layer (`cart-signature.ts`,
 * `storefront-handler.ts`) and mirrored **verbatim** by
 * `extensions/imprintid-cart-pricing/src/cart-pricing-contract.ts` (the Shopify Function
 * cannot import outside its own directory — same rule as `hmac-sha256.ts`). The two
 * copies are kept identical by construction and cross-checked by the shared golden
 * vectors in `test/fixtures/signed-quote-vectors-v2.json`
 * (`app/lib/pricing-api/cart-pricing-contract-vectors.test.ts` +
 * `extensions/imprintid-cart-pricing/src/cart-pricing-contract-vectors.test.ts`).
 *
 * Nothing here calculates a price. It only defines the shape both sides must agree on.
 */

// ---------------------------------------------------------------------------
// Envelope versions
// ---------------------------------------------------------------------------

export const ENVELOPE_V1 = 1 as const;
export const ENVELOPE_V2 = 2 as const;

/** The line-attribute keys. Underscore-prefixed so Shopify treats them as private
 * (hidden from the storefront line-item property display). v1 uses the first three;
 * v2 adds `config`. */
export const CART_PRICING_ATTRS = {
  version: "_imprintid_pricing_version",
  payload: "_imprintid_pricing_payload",
  signature: "_imprintid_pricing_signature",
  /** v2 only: the normalized-configuration JSON whose SHA-256 must equal the signed
   * `configDigest`. Carried in the clear (it is not secret) but tamper-evident via the
   * digest. */
  config: "_imprintid_pricing_config",
} as const;

// ---------------------------------------------------------------------------
// Enforcement policy modes (app-owned shop metafield `mode`)
// ---------------------------------------------------------------------------

/**
 * - `disabled`   — dynamic enforcement intentionally off. Native pricing is permitted
 *                  only through documented business authorization. The Transform emits
 *                  no enforcement operation.
 * - `pilot`      — only products carrying an active `required=true` product policy are
 *                  enforced. Everything else is untouched.
 * - `universal`  — every ordinary product requires an active product policy AND a valid
 *                  signed quote. A missing/inactive policy or an invalid quote yields no
 *                  Transform operation (native price falls through until the Validation
 *                  Function ships — see docs/architecture) and is marked for Validation
 *                  rejection.
 * - `maintenance`— the secure technical rollback during a pricing incident: enforced
 *                  products get NO dynamic pricing operation and the Validation Function
 *                  is expected to BLOCK them from cart/checkout. There is deliberately no
 *                  native-price fallback for enforced products in this mode.
 */
export type EnforcementMode = "disabled" | "pilot" | "universal" | "maintenance";

export const ENFORCEMENT_MODES: readonly EnforcementMode[] = [
  "disabled",
  "pilot",
  "universal",
  "maintenance",
] as const;

export function isEnforcementMode(value: unknown): value is EnforcementMode {
  return typeof value === "string" && (ENFORCEMENT_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// App-owned metafield identity
// ---------------------------------------------------------------------------

/** App-reserved metafield namespace. Both the shop `enforcement_policy` and each
 * product `pricing_policy` live here. App-owned ⇒ merchants cannot edit them ⇒ they are
 * a valid authoritative-policy source for a Function (Task 5A constraint #9). NO VALUES
 * OR DEFINITIONS ARE CREATED IN TASK 5B.1 — this is only the agreed identity. */
export const CART_PRICING_METAFIELD = {
  namespace: "$app:imprintid",
  shopPolicyKey: "enforcement_policy",
  productPolicyKey: "pricing_policy",
} as const;

// ---------------------------------------------------------------------------
// Currency (Task 5B.3B.2) — single-currency, NO foreign-exchange
// ---------------------------------------------------------------------------

/** Canonical ISO-4217 alpha code: exactly three A–Z letters. */
export const ISO_4217_ALPHA = /^[A-Z]{3}$/;

/**
 * Normalizes a currency code to canonical ISO-4217 form (three A–Z letters, upper
 * case), trimming only surrounding whitespace. Returns `null` for anything else — never
 * a guess, never a default. Used identically by the server (before it signs a quote)
 * and by the Cart Transform / Validation Functions (before they accept one) so a
 * currency decision can never drift between the two sides.
 *
 * The initial release performs NO foreign-exchange conversion: the server signs a
 * quote only when the pricing-profile currency already equals the shop currency, and a
 * Function only prices a line whose own Shopify cart currency equals the signed
 * currency. Everything else fails closed.
 */
export function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return ISO_4217_ALPHA.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Parsing / structural limits — every breach fails CLOSED
// ---------------------------------------------------------------------------

export const CART_PRICING_LIMITS = {
  /** Max UTF-8 bytes of the `_imprintid_pricing_payload` attribute. */
  maxPayloadBytes: 4096,
  /** Max UTF-8 bytes of the `_imprintid_pricing_config` attribute. */
  maxConfigBytes: 8192,
  /** Max object nesting depth accepted by config normalization. */
  maxConfigDepth: 8,
  /** Max total object keys across the whole normalized config. */
  maxConfigKeys: 200,
  /** Max array length anywhere in the config. */
  maxConfigArrayLength: 200,
  /** Quantity must be an integer in [1, this]. */
  maxQuantity: 1_000_000,
  /** Any single cents field must be an integer in [0, this] and a safe integer. */
  maxComponentCents: 1_000_000_00,
  /** Reconstructed line total ceiling (sanity bound; well under Number.MAX_SAFE_INTEGER). */
  maxLineTotalCents: 100_000_000_00,
} as const;

// ---------------------------------------------------------------------------
// Customer-safe reject codes
// ---------------------------------------------------------------------------

/** Internal reason a quote was rejected. NEVER shown raw to a customer — it only selects
 * a generic message (see CUSTOMER_SAFE_MESSAGE). Kept as a closed union so the Transform
 * and the future Validation Function classify failures identically.
 *
 * Task 5B.3B.2 currency reject codes and their cross-layer names:
 *   - `currency_mismatch`            ≡ QUOTE_CART_CURRENCY_MISMATCH — the signed quote's
 *                                     currency ≠ Shopify's own authoritative cart-line currency.
 *   - `currency_context_unavailable` ≡ CURRENCY_CONTEXT_UNAVAILABLE — a currency value
 *                                     required to make the comparison is missing/malformed.
 * (The server-side pre-sign reason PROFILE_SHOP_CURRENCY_MISMATCH lives in
 * `app/lib/pricing-api/currency-contract.ts` — it never reaches a Function.) */
export type QuoteRejectCode =
  | "not_enforced"
  | "missing"
  | "malformed"
  | "unsupported_version"
  | "unknown_fields"
  | "bad_signature"
  | "install_mismatch"
  | "product_mismatch"
  | "variant_mismatch"
  | "quantity_mismatch"
  | "currency_mismatch"
  | "currency_context_unavailable"
  | "profile_ref_mismatch"
  | "profile_revision_mismatch"
  | "policy_revision_mismatch"
  | "adjustment_mismatch"
  | "config_digest_mismatch"
  | "monetary_invariant"
  | "line_total_mismatch"
  | "policy_missing"
  | "policy_inactive";

/** The only strings a customer ever sees. Deliberately vague — they never reveal which
 * check failed. */
export const CUSTOMER_SAFE_MESSAGE = {
  reconfigure: "Please re-configure this item before checking out.",
  changed: "Your selection changed — please re-configure this item.",
  unavailable: "This product isn't available for purchase right now.",
} as const;

export function customerSafeMessageFor(code: QuoteRejectCode): string {
  switch (code) {
    case "policy_missing":
    case "policy_inactive":
      return CUSTOMER_SAFE_MESSAGE.unavailable;
    case "product_mismatch":
    case "variant_mismatch":
    case "quantity_mismatch":
    case "currency_mismatch":
    case "currency_context_unavailable":
    case "config_digest_mismatch":
      return CUSTOMER_SAFE_MESSAGE.changed;
    default:
      return CUSTOMER_SAFE_MESSAGE.reconfigure;
  }
}

// ---------------------------------------------------------------------------
// v2 payload shape + canonical field order
// ---------------------------------------------------------------------------

/**
 * Envelope v2. Every field has a security purpose (Task 5A §7); nothing decorative.
 *
 * `installBinding` — an install-specific opaque value the app sets in the app-owned shop
 *   `enforcement_policy` metafield at install time. The Shopify Function's input schema
 *   exposes NO `Shop.id` (verified against the pinned `2026-07` schema —
 *   `Input.shop: Shop` has only `localTime`, `metafield`, `metaobject`), so a raw shop
 *   GID could not be authoritatively checked. The Function instead reads
 *   `enforcement_policy.installBinding` from the metafield it already queries and
 *   requires `payload.installBinding === that value`. Because the metafield is app-owned
 *   (merchant-uneditable), this authoritatively binds a quote to one install.
 */
export interface CartPricingPayloadV2 {
  v: typeof ENVELOPE_V2;
  installBinding: string;
  productGid: string;
  variantGid: string;
  quantity: number;
  currency: string;
  baseUnitPriceCents: number;
  perUnitSurchargeCents: number;
  flatSurchargeCents: number;
  lineTotalCents: number;
  adjustmentVariantGid: string;
  profileRef: string;
  profileRevision: number;
  policyRevision: number;
  configDigest: string;
  quoteId: string;
  /** Advisory only. Signed so it is tamper-evident for server-side auditing. MUST NOT be
   * compared against a clock inside a Function (Shopify Functions are deterministic —
   * Task 5A constraint #8). */
  issuedAtServer: number;
}

/** The exact key set of a v2 payload — used to reject unknown/missing fields (fail
 * closed). Order here is irrelevant; canonicalization sorts. */
export const V2_PAYLOAD_KEYS: readonly (keyof CartPricingPayloadV2)[] = [
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
] as const;

/**
 * The canonical field order = the payload keys sorted ascending (same mechanism as v1:
 * `Object.keys().sort()`). Enumerated here so a test can assert the serializer never
 * drifts. If a future field is added, add it here in sorted position and bump the
 * envelope version.
 */
export const V2_CANONICAL_FIELD_ORDER: readonly string[] = [
  "adjustmentVariantGid",
  "baseUnitPriceCents",
  "configDigest",
  "currency",
  "flatSurchargeCents",
  "installBinding",
  "issuedAtServer",
  "lineTotalCents",
  "perUnitSurchargeCents",
  "policyRevision",
  "productGid",
  "profileRef",
  "profileRevision",
  "quantity",
  "quoteId",
  "v",
  "variantGid",
];

/**
 * Canonicalizes a v2 payload to the deterministic string that is HMAC-signed: sorted
 * `key=value` pairs joined with `\n`. Identical mechanism to
 * `canonicalizeCartPricingPayload` (v1) so both envelopes share one serializer concept.
 * All values are primitives (`string | number`), so `String(v)` is exact.
 */
export function canonicalizeCartPricingPayloadV2(payload: CartPricingPayloadV2): string {
  const record = payload as unknown as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${String(record[key])}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Monetary invariants — derived exactly from the existing lineExpand implementation
// ---------------------------------------------------------------------------

export interface MonetaryComponents {
  baseUnitPriceCents: number;
  perUnitSurchargeCents: number;
  flatSurchargeCents: number;
  quantity: number;
}

function isSafeNonNegativeInteger(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

/**
 * The exact line total the current Cart Transform reconstructs from its expanded
 * components (see `extensions/imprintid-cart-pricing/src/cart_transform_run.ts`):
 *
 *   base component      : merchandise = base variant,      qty = quantity, per-unit = baseUnitPriceCents
 *   surcharge component : merchandise = adjustment variant, qty = 1, per-unit =
 *                         perUnitSurchargeCents * quantity + flatSurchargeCents (only if > 0)
 *
 *   lineTotalCents = baseUnitPriceCents * quantity
 *                  + perUnitSurchargeCents * quantity
 *                  + flatSurchargeCents            (× 1)
 *
 * Pure integer arithmetic — no floating-point cents anywhere. This is a re-grouping of
 * the same numbers the pricing engine already produced, never a new calculation.
 */
export function computeLineTotalCents(c: MonetaryComponents): number {
  return c.baseUnitPriceCents * c.quantity + c.perUnitSurchargeCents * c.quantity + c.flatSurchargeCents;
}

/** How many expanded components the Transform will emit: the base plus one combined
 * surcharge component when the total surcharge is non-zero. */
export function expectedExpandedComponentCount(c: MonetaryComponents): 1 | 2 | 3 {
  return (1 + (c.perUnitSurchargeCents * c.quantity + c.flatSurchargeCents > 0 ? 1 : 0)) as 1 | 2;
}

/**
 * Validates every monetary invariant. Returns a `QuoteRejectCode` on the first breach,
 * or `null` when all invariants hold. Never throws.
 */
export function checkMonetaryInvariants(
  c: MonetaryComponents,
  signedLineTotalCents: number,
): QuoteRejectCode | null {
  if (!isSafeNonNegativeInteger(c.baseUnitPriceCents, CART_PRICING_LIMITS.maxComponentCents)) return "monetary_invariant";
  if (!isSafeNonNegativeInteger(c.perUnitSurchargeCents, CART_PRICING_LIMITS.maxComponentCents)) return "monetary_invariant";
  if (!isSafeNonNegativeInteger(c.flatSurchargeCents, CART_PRICING_LIMITS.maxComponentCents)) return "monetary_invariant";
  if (
    typeof c.quantity !== "number" ||
    !Number.isInteger(c.quantity) ||
    c.quantity < 1 ||
    c.quantity > CART_PRICING_LIMITS.maxQuantity
  ) {
    return "monetary_invariant";
  }
  if (!isSafeNonNegativeInteger(signedLineTotalCents, CART_PRICING_LIMITS.maxLineTotalCents)) return "monetary_invariant";

  const computed = computeLineTotalCents(c);
  if (!Number.isSafeInteger(computed) || computed > CART_PRICING_LIMITS.maxLineTotalCents) return "monetary_invariant";
  if (computed !== signedLineTotalCents) return "line_total_mismatch";
  return null;
}
