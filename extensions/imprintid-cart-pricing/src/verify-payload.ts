import { signHex, timingSafeEqualHex } from "./hmac-sha256.ts";

/**
 * Mirrors `CartPricingPayload` in `app/lib/pricing-api/cart-signature.ts` exactly —
 * this Function never calculates a price, so it needs the server's own definition of
 * what a valid payload contains, not a new one. If that file's shape changes, this
 * type (and `parsePayload` below) must change identically.
 */
export interface CartPricingPayload {
  v: 1;
  sku: string;
  quantity: number;
  currency: string;
  baseVariantId: string;
  baseUnitPriceCents: number;
  perUnitSurchargeCents: number;
  flatSurchargeCents: number;
  adjustmentVariantId: string;
  expiresAt: number;
}

export type VerifyFailureReason =
  | "missing_attributes"
  | "unsupported_version"
  | "malformed_payload"
  | "invalid_signature"
  | "quantity_mismatch"
  | "variant_mismatch"
  | "invalid_price";

export type VerifyResult = { ok: true; payload: CartPricingPayload } | { ok: false; reason: VerifyFailureReason };

/** Identical sorted-`key=value` canonicalization to
 * `app/lib/pricing-api/cart-signature.ts#canonicalizeCartPricingPayload` — see that
 * file's doc comment for why a real separator is used instead of App Proxy's
 * no-separator convention. Must stay byte-for-byte identical to the server's version,
 * or every signature verification fails. */
function canonicalize(payload: CartPricingPayload): string {
  const record = payload as unknown as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${String(record[key])}`)
    .join("\n");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** Structural validation only (types/shape) — never trusts the parsed object is
 * authentic; that's what the signature check in `verifyCartPricingAttributes` is for.
 * Rejecting a malformed shape here, before ever touching the signature, means a
 * corrupted-but-still-somehow-signature-matching payload (which shouldn't be possible,
 * but this is defense in depth) still can't produce a usable `CartPricingPayload`. */
function parsePayload(raw: string): CartPricingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  if (p.v !== 1) return null;
  if (!isNonEmptyString(p.sku)) return null;
  if (!isFiniteNonNegativeInteger(p.quantity) || p.quantity < 1) return null;
  if (!isNonEmptyString(p.currency)) return null;
  if (!isNonEmptyString(p.baseVariantId)) return null;
  if (!isFiniteNonNegativeInteger(p.baseUnitPriceCents)) return null;
  if (!isFiniteNonNegativeInteger(p.perUnitSurchargeCents)) return null;
  if (!isFiniteNonNegativeInteger(p.flatSurchargeCents)) return null;
  if (!isNonEmptyString(p.adjustmentVariantId)) return null;
  if (!isFiniteNonNegativeInteger(p.expiresAt)) return null;

  return {
    v: 1,
    sku: p.sku,
    quantity: p.quantity,
    currency: p.currency,
    baseVariantId: p.baseVariantId,
    baseUnitPriceCents: p.baseUnitPriceCents,
    perUnitSurchargeCents: p.perUnitSurchargeCents,
    flatSurchargeCents: p.flatSurchargeCents,
    adjustmentVariantId: p.adjustmentVariantId,
    expiresAt: p.expiresAt,
  };
}

export interface CartLineForVerification {
  quantity: number;
  merchandiseId: string | null;
}

export interface CartPricingAttributes {
  version: string | null;
  payload: string | null;
  signature: string | null;
}

/**
 * The v1 Function trust boundary. LEGACY / COMPATIBILITY ONLY (Task 5B.1): v1 is
 * accepted while envelope-v2 prerequisites (the app-owned metafield revisions) are
 * absent, and carries NO replay protection — the Function-side `expiresAt` /
 * `Date.now()` check was removed (Shopify Functions are deterministic; a clock is not
 * allowed). Replay/expiry protection lives only in envelope v2 (`verify-payload-v2.ts`),
 * bound to `profileRevision` / `policyRevision`. `expiresAt` is still parsed for shape
 * compatibility but never compared here.
 *
 * Never throws — every failure is a normal `{ ok: false }` return, so one bad line never
 * prevents other lines in the same cart from being processed.
 */
export function verifyCartPricingAttributes(
  secret: string,
  cartLine: CartLineForVerification,
  attrs: CartPricingAttributes,
): VerifyResult {
  if (!isNonEmptyString(attrs.version) || !isNonEmptyString(attrs.payload) || !isNonEmptyString(attrs.signature)) {
    return { ok: false, reason: "missing_attributes" };
  }

  if (attrs.version !== "1") {
    return { ok: false, reason: "unsupported_version" };
  }

  const payload = parsePayload(attrs.payload);
  if (!payload) {
    return { ok: false, reason: "malformed_payload" };
  }

  const expectedSignature = signHex(secret, canonicalize(payload));
  if (!timingSafeEqualHex(attrs.signature, expectedSignature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  if (payload.quantity !== cartLine.quantity) {
    return { ok: false, reason: "quantity_mismatch" };
  }

  if (!cartLine.merchandiseId || payload.baseVariantId !== cartLine.merchandiseId) {
    return { ok: false, reason: "variant_mismatch" };
  }

  if (payload.baseUnitPriceCents < 0 || payload.perUnitSurchargeCents < 0 || payload.flatSurchargeCents < 0) {
    return { ok: false, reason: "invalid_price" };
  }

  return { ok: true, payload };
}
