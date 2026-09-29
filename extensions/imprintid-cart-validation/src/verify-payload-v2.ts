/**
 * Envelope v2 verification for the `imprintid-cart-pricing` Cart Transform (Task 5B.1).
 *
 * Mirrors the server's `cart-signature.ts` v2 construction. This Function never
 * calculates a price — it verifies a signature the server produced and cross-checks
 * every bound field against **Shopify-owned** data (the app-owned shop + product policy
 * metafields the input query fetches), never against customer-supplied line properties.
 *
 * NO CLOCK. Replay/expiry is revision-bound: a v2 quote carries `profileRevision` and
 * `policyRevision`; this module compares them to the CURRENT values in the metafields.
 * A stale quote fails closed deterministically without `Date.now()`.
 *
 * Every rejection is a plain `{ ok: false, reason }` — never a throw — so one bad line
 * never prevents other lines in the same cart from being processed.
 */

import { signHex, timingSafeEqualHex } from "./hmac-sha256.ts";
import { digestOfConfigJson } from "./config-normalization.ts";
import {
  CART_PRICING_LIMITS,
  ENVELOPE_V2,
  V2_PAYLOAD_KEYS,
  canonicalizeCartPricingPayloadV2,
  checkMonetaryInvariants,
  isEnforcementMode,
  normalizeCurrencyCode,
  type CartPricingPayloadV2,
  type EnforcementMode,
  type QuoteRejectCode,
} from "./cart-pricing-contract.ts";

// ---------------------------------------------------------------------------
// Parsed policy metafields
// ---------------------------------------------------------------------------

/** The only schema version this Function understands. A metafield carrying anything
 * else fails closed rather than being interpreted under the wrong rules. */
export const POLICY_SCHEMA_VERSION = 1;

/** Defensive upper bound on a policy metafield's serialized size. Real policies are a
 * few hundred bytes; anything larger is treated as hostile/malformed. */
const MAX_POLICY_JSON_BYTES = 2048;

/** Bounds on `installBinding` / `profileRef` / GID strings. */
const MAX_POLICY_STRING_LEN = 256;

export interface ShopEnforcementPolicy {
  schema: number;
  mode: EnforcementMode;
  enabled: boolean;
  /** Explicit, defaults to `false` when the field is absent. Only `true` on a valid
   * `pilot` policy authorizes legacy envelope-v1 processing. */
  allowLegacyV1: boolean;
  adjustmentVariantGid: string;
  installBinding: string;
  policyRevision: number;
}

export interface ProductPricingPolicy {
  schema: number;
  required: boolean;
  profileRef: string;
  profileRevision: number;
  active: boolean;
  policyRevision: number;
}

const SHOP_POLICY_KEYS = new Set([
  "schema",
  "mode",
  "enabled",
  "allowLegacyV1",
  "adjustmentVariantGid",
  "installBinding",
  "policyRevision",
]);
const PRODUCT_POLICY_KEYS = new Set([
  "schema",
  "required",
  "profileRef",
  "profileRevision",
  "active",
  "policyRevision",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function boundedString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_POLICY_STRING_LEN ? v : null;
}
/** A positive safe integer (`>= 1`). Revisions and schema versions are all positive. */
function positiveSafeInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v) && v >= 1 ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function withinSizeBudget(jsonValue: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(jsonValue)).length <= MAX_POLICY_JSON_BYTES;
  } catch {
    return false;
  }
}
function hasOnlyKnownKeys(r: Record<string, unknown>, known: Set<string>): boolean {
  for (const key of Object.keys(r)) if (!known.has(key)) return false;
  return true;
}
const GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;

/**
 * Strictly parses the shop `$app:imprintid/enforcement_policy` metafield JSON.
 * Returns `null` — which the Transform treats as **fail closed / no operation**, never
 * as backward compatibility — for ANY of: not a plain object; over the size budget; an
 * unknown key present; wrong `schema`; unsupported `mode`; non-boolean `enabled`;
 * non-boolean `allowLegacyV1` when present; a blank / over-long / non-GID
 * `adjustmentVariantGid`; a blank / over-long `installBinding`; a non-positive-safe-int
 * `policyRevision`. Missing `allowLegacyV1` defaults to `false`.
 */
export function parseShopEnforcementPolicy(jsonValue: unknown): ShopEnforcementPolicy | null {
  const r = asRecord(jsonValue);
  if (!r) return null;
  if (!withinSizeBudget(r)) return null;
  if (!hasOnlyKnownKeys(r, SHOP_POLICY_KEYS)) return null;

  if (positiveSafeInt(r.schema) !== POLICY_SCHEMA_VERSION) return null;
  if (!isEnforcementMode(r.mode)) return null;
  const enabled = bool(r.enabled);
  if (enabled === null) return null;

  // Missing → false. Present → must be a real boolean.
  let allowLegacyV1 = false;
  if (Object.prototype.hasOwnProperty.call(r, "allowLegacyV1")) {
    const parsed = bool(r.allowLegacyV1);
    if (parsed === null) return null;
    allowLegacyV1 = parsed;
  }

  const adjustmentVariantGid = boundedString(r.adjustmentVariantGid);
  if (!adjustmentVariantGid || !GID_VARIANT.test(adjustmentVariantGid)) return null;
  const installBinding = boundedString(r.installBinding);
  if (!installBinding) return null;
  const policyRevision = positiveSafeInt(r.policyRevision);
  if (policyRevision === null) return null;

  return { schema: POLICY_SCHEMA_VERSION, mode: r.mode, enabled, allowLegacyV1, adjustmentVariantGid, installBinding, policyRevision };
}

/**
 * Strictly parses a product `$app:imprintid/pricing_policy` metafield JSON. Returns
 * `null` for missing/malformed — the caller decides what a `null` means per mode (in
 * `universal` mode it is classified for future Validation rejection).
 */
export function parseProductPricingPolicy(jsonValue: unknown): ProductPricingPolicy | null {
  const r = asRecord(jsonValue);
  if (!r) return null;
  if (!withinSizeBudget(r)) return null;
  if (!hasOnlyKnownKeys(r, PRODUCT_POLICY_KEYS)) return null;

  if (positiveSafeInt(r.schema) !== POLICY_SCHEMA_VERSION) return null;
  const required = bool(r.required);
  const active = bool(r.active);
  if (required === null || active === null) return null;
  const profileRef = boundedString(r.profileRef);
  if (!profileRef) return null;
  const profileRevision = positiveSafeInt(r.profileRevision);
  const policyRevision = positiveSafeInt(r.policyRevision);
  if (profileRevision === null || policyRevision === null) return null;

  return { schema: POLICY_SCHEMA_VERSION, required, profileRef, profileRevision, active, policyRevision };
}

// ---------------------------------------------------------------------------
// Strict v2 payload parse (rejects unknown / missing / wrong-typed fields)
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v) && v >= 0;
}

export function parseV2Payload(raw: string): CartPricingPayloadV2 | null {
  if (raw.length > CART_PRICING_LIMITS.maxPayloadBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = asRecord(parsed);
  if (!p) return null;

  // exact key set — no unknown fields, no missing fields
  const keys = Object.keys(p);
  if (keys.length !== V2_PAYLOAD_KEYS.length) return null;
  for (const k of V2_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(p, k)) return null;
  }

  if (p.v !== ENVELOPE_V2) return null;
  if (!isNonEmptyString(p.installBinding)) return null;
  if (!isNonEmptyString(p.productGid)) return null;
  if (!isNonEmptyString(p.variantGid)) return null;
  if (!isNonNegSafeInt(p.quantity) || (p.quantity as number) < 1) return null;
  if (!isNonEmptyString(p.currency)) return null;
  if (!isNonNegSafeInt(p.baseUnitPriceCents)) return null;
  if (!isNonNegSafeInt(p.perUnitSurchargeCents)) return null;
  if (!isNonNegSafeInt(p.flatSurchargeCents)) return null;
  if (!isNonNegSafeInt(p.lineTotalCents)) return null;
  if (!isNonEmptyString(p.adjustmentVariantGid)) return null;
  if (!isNonEmptyString(p.profileRef)) return null;
  if (!isNonNegSafeInt(p.profileRevision)) return null;
  if (!isNonNegSafeInt(p.policyRevision)) return null;
  if (!isNonEmptyString(p.configDigest)) return null;
  if (!isNonEmptyString(p.quoteId)) return null;
  if (!isNonNegSafeInt(p.issuedAtServer)) return null;

  return {
    v: ENVELOPE_V2,
    installBinding: p.installBinding as string,
    productGid: p.productGid as string,
    variantGid: p.variantGid as string,
    quantity: p.quantity as number,
    currency: p.currency as string,
    baseUnitPriceCents: p.baseUnitPriceCents as number,
    perUnitSurchargeCents: p.perUnitSurchargeCents as number,
    flatSurchargeCents: p.flatSurchargeCents as number,
    lineTotalCents: p.lineTotalCents as number,
    adjustmentVariantGid: p.adjustmentVariantGid as string,
    profileRef: p.profileRef as string,
    profileRevision: p.profileRevision as number,
    policyRevision: p.policyRevision as number,
    configDigest: p.configDigest as string,
    quoteId: p.quoteId as string,
    issuedAtServer: p.issuedAtServer as number,
  };
}

// ---------------------------------------------------------------------------
// Full v2 verification
// ---------------------------------------------------------------------------

export interface V2LineFacts {
  quantity: number;
  variantGid: string | null;
  productGid: string | null;
  /** currency code from `cost.amountPerQuantity.currencyCode` (or `totalAmount`), when present */
  currencyCode: string | null;
}

export interface V2Attributes {
  version: string | null;
  payload: string | null;
  signature: string | null;
  config: string | null;
}

export type V2VerifyResult =
  | { ok: true; payload: CartPricingPayloadV2 }
  | { ok: false; reason: QuoteRejectCode };

export function verifyCartPricingAttributesV2(
  secret: string,
  line: V2LineFacts,
  attrs: V2Attributes,
  shopPolicy: ShopEnforcementPolicy,
  productPolicy: ProductPricingPolicy,
): V2VerifyResult {
  if (!isNonEmptyString(attrs.version) || !isNonEmptyString(attrs.payload) || !isNonEmptyString(attrs.signature)) {
    return { ok: false, reason: "missing" };
  }
  if (attrs.version !== "2") return { ok: false, reason: "unsupported_version" };
  if (!isNonEmptyString(attrs.config)) return { ok: false, reason: "missing" };

  const payload = parseV2Payload(attrs.payload);
  if (!payload) return { ok: false, reason: "malformed" };

  // --- Cheap rejection checks before HMAC ---
  //
  // These values are all subsequently covered by the HMAC. Checking them first cannot
  // authorize a line; it only rejects a line that is already impossible to accept.
  // This keeps a stale quote from consuming the Function's instruction budget before a
  // current quote in the same cart can be evaluated.
  // --- Shopify-owned identity / revision binding (never from line properties) ---
  if (payload.installBinding !== shopPolicy.installBinding) return { ok: false, reason: "install_mismatch" };
  if (payload.adjustmentVariantGid !== shopPolicy.adjustmentVariantGid) return { ok: false, reason: "adjustment_mismatch" };
  if (payload.policyRevision !== shopPolicy.policyRevision) return { ok: false, reason: "policy_revision_mismatch" };
  if (payload.profileRef !== productPolicy.profileRef) return { ok: false, reason: "profile_ref_mismatch" };
  if (payload.profileRevision !== productPolicy.profileRevision) return { ok: false, reason: "profile_revision_mismatch" };

  // --- line ownership ---
  if (!line.variantGid || payload.variantGid !== line.variantGid) return { ok: false, reason: "variant_mismatch" };
  if (!line.productGid || payload.productGid !== line.productGid) return { ok: false, reason: "product_mismatch" };
  if (payload.quantity !== line.quantity) return { ok: false, reason: "quantity_mismatch" };

  // --- currency (MANDATORY for an enforced line — Task 5B.3B.2) ---
  // The signed quote's currency must equal Shopify's own authoritative cart-line
  // currency. A missing/malformed cart currency FAILS CLOSED (no operation) — it is
  // never skipped: an enforced line whose currency cannot be verified must not be
  // priced. NO foreign-exchange is ever performed here — the server only signs a quote
  // whose currency already equals the shop currency, so an equal cart currency means
  // the buyer is transacting at par; an unequal one means a different presentment
  // currency the quote simply does not apply to.
  const cartCurrency = normalizeCurrencyCode(line.currencyCode);
  const quoteCurrency = normalizeCurrencyCode(payload.currency);
  if (cartCurrency === null || quoteCurrency === null) return { ok: false, reason: "currency_context_unavailable" };
  if (cartCurrency !== quoteCurrency) return { ok: false, reason: "currency_mismatch" };

  // --- configuration digest ---
  const recomputed = digestOfConfigJson(attrs.config);
  if (!recomputed.ok || recomputed.digest !== payload.configDigest) {
    return { ok: false, reason: "config_digest_mismatch" };
  }

  // --- monetary invariants + exact line-total formula ---
  const invariant = checkMonetaryInvariants(
    {
      baseUnitPriceCents: payload.baseUnitPriceCents,
      perUnitSurchargeCents: payload.perUnitSurchargeCents,
      flatSurchargeCents: payload.flatSurchargeCents,
      quantity: payload.quantity,
    },
    payload.lineTotalCents,
  );
  if (invariant !== null) return { ok: false, reason: invariant };

  // Authenticate only after every inexpensive structural and policy check passes.
  // The HMAC is deliberately last: it is the expensive trust-boundary operation.
  const expectedSig = signHex(secret, canonicalizeCartPricingPayloadV2(payload));
  if (!timingSafeEqualHex(attrs.signature, expectedSig)) return { ok: false, reason: "bad_signature" };

  return { ok: true, payload };
}
