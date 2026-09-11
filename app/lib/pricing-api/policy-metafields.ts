/**
 * Task 5B.3A — server-side parsing of the app-owned enforcement policy metafields.
 *
 * MIRRORS `extensions/imprintid-cart-pricing/src/verify-payload-v2.ts`
 * (`parseShopEnforcementPolicy` / `parseProductPricingPolicy`) field-for-field. The two
 * copies exist because a Shopify Function cannot import application code (same rule as
 * `hmac-sha256.ts` / `cart-pricing-contract.ts`).
 *
 * The two sides are NOT signing-critical to keep byte-identical (unlike the
 * canonicalization + HMAC): the application uses this only to decide *whether to issue a
 * signed v2 quote at all*, and the Cart Transform / Validation Functions independently
 * re-validate every bound field against the same metafields on their own side. If this
 * parser were ever slightly stricter, the app would simply not sign (fail closed at the
 * browser); if slightly more lenient, the app would sign a quote the Function then
 * rejects (fail closed at the Function). Either way the customer cannot buy at the wrong
 * price. Parity is maintained as defense-in-depth, not as a correctness dependency.
 *
 * Every rejection returns `null` — the caller treats that as FAIL CLOSED (no v2 quote),
 * never as backward compatibility.
 */

import { isEnforcementMode, type EnforcementMode } from "./cart-pricing-contract.ts";

/** The only policy schema version understood here. */
export const POLICY_SCHEMA_VERSION = 1;

const MAX_POLICY_JSON_BYTES = 2048;
const MAX_POLICY_STRING_LEN = 256;
const GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;

export interface ShopEnforcementPolicy {
  schema: number;
  mode: EnforcementMode;
  enabled: boolean;
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

export function parseShopEnforcementPolicy(jsonValue: unknown): ShopEnforcementPolicy | null {
  const r = asRecord(jsonValue);
  if (!r) return null;
  if (!withinSizeBudget(r)) return null;
  if (!hasOnlyKnownKeys(r, SHOP_POLICY_KEYS)) return null;

  if (positiveSafeInt(r.schema) !== POLICY_SCHEMA_VERSION) return null;
  if (!isEnforcementMode(r.mode)) return null;
  const enabled = bool(r.enabled);
  if (enabled === null) return null;

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

  return {
    schema: POLICY_SCHEMA_VERSION,
    mode: r.mode,
    enabled,
    allowLegacyV1,
    adjustmentVariantGid,
    installBinding,
    policyRevision,
  };
}

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
