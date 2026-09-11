/**
 * Deterministic normalization + SHA-256 digest of a "selected configuration".
 *
 * Task 5B.1. The digest binds a signed price to the exact configuration that produced
 * it (closes the "cheap quote, expensive job" gap — Task 5A §5). This module is mirrored
 * verbatim into `extensions/imprintid-cart-pricing/src/config-normalization.ts`; the
 * shared golden vectors prove the browser (future), the server signer, and the Function
 * verifier all produce byte-identical output.
 *
 * Rules (all breaches → fail closed, `{ ok: false }`):
 *  - Accepts ONLY plain-JSON data: plain objects, arrays, strings, booleans,
 *    safe-integer numbers, and `null`.
 *  - Rejects: non-integer / non-finite / non-safe numbers (no floating-point monetary
 *    values), `undefined` as a value, `bigint`, `symbol`, functions, `Date`, and any
 *    object whose prototype is not `Object.prototype` (class instances, `Map`, `Set`).
 *  - Object keys are sorted recursively (ascending, by code unit).
 *  - Array order is PRESERVED (arrays are only used where order is semantically
 *    meaningful — e.g. a caller passes an already-sorted list of option value ids).
 *  - An omitted object key and an explicit `null` are distinct and both allowed;
 *    `undefined` values are rejected (callers must omit the key instead).
 *  - Depth, total-key, array-length, and serialized-byte limits from
 *    `cart-pricing-contract.ts#CART_PRICING_LIMITS`.
 *  - Output: minified JSON (no whitespace), UTF-8; digest = `sha256:` + lowercase hex.
 *
 * Do NOT pass raw React state, DOM nodes, or anything containing customer personal
 * information. The caller is responsible for building a small, PII-free plain object.
 */

import { sha256, bytesToHex, utf8ToBytes } from "./hmac-sha256.ts";
import { CART_PRICING_LIMITS } from "./cart-pricing-contract.ts";

export type ConfigNormalizationFailure =
  | "unsupported_type"
  | "non_integer_number"
  | "too_deep"
  | "too_many_keys"
  | "array_too_long"
  | "too_large";

export type ConfigNormalizationResult =
  | { ok: true; canonicalJson: string; digest: string }
  | { ok: false; reason: ConfigNormalizationFailure };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

class ConfigNormalizationError extends Error {
  readonly reason: ConfigNormalizationFailure;
  constructor(reason: ConfigNormalizationFailure) {
    super(reason);
    this.reason = reason;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursively validates + rebuilds `value` as sorted-key JSON. Throws a
 * `ConfigNormalizationError` on any violation (caught by `normalizeConfig`). */
function normalizeValue(value: unknown, depth: number, keyCounter: { n: number }): JsonValue {
  if (depth > CART_PRICING_LIMITS.maxConfigDepth) throw new ConfigNormalizationError("too_deep");

  if (value === null) return null;

  const t = typeof value;

  if (t === "string") return value as string;
  if (t === "boolean") return value as boolean;

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n) || !Number.isInteger(n) || !Number.isSafeInteger(n)) {
      throw new ConfigNormalizationError("non_integer_number");
    }
    return n;
  }

  if (Array.isArray(value)) {
    if (value.length > CART_PRICING_LIMITS.maxConfigArrayLength) {
      throw new ConfigNormalizationError("array_too_long");
    }
    // Array ORDER IS PRESERVED — never sorted.
    return value.map((element) => normalizeValue(element, depth + 1, keyCounter));
  }

  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      keyCounter.n += 1;
      if (keyCounter.n > CART_PRICING_LIMITS.maxConfigKeys) {
        throw new ConfigNormalizationError("too_many_keys");
      }
      const child = value[key];
      if (child === undefined) {
        // An explicit `undefined` value is not representable in JSON — callers must omit
        // the key. Rejecting (not silently dropping) keeps server and Function identical.
        throw new ConfigNormalizationError("unsupported_type");
      }
      out[key] = normalizeValue(child, depth + 1, keyCounter);
    }
    return out;
  }

  // bigint, symbol, function, undefined, Date, Map, Set, class instances, …
  throw new ConfigNormalizationError("unsupported_type");
}

/** Minified JSON writer over already-normalized values. `JSON.stringify` on a
 * sorted-key structure is deterministic, but we go through it explicitly so the
 * contract is "we serialize this exact shape". */
function writeCanonicalJson(value: JsonValue): string {
  return JSON.stringify(value);
}

export function normalizeConfig(input: unknown): ConfigNormalizationResult {
  let normalized: JsonValue;
  try {
    normalized = normalizeValue(input, 0, { n: 0 });
  } catch (error) {
    if (error instanceof ConfigNormalizationError) return { ok: false, reason: error.reason };
    return { ok: false, reason: "unsupported_type" };
  }

  const canonicalJson = writeCanonicalJson(normalized);
  const bytes = utf8ToBytes(canonicalJson);
  if (bytes.length > CART_PRICING_LIMITS.maxConfigBytes) {
    return { ok: false, reason: "too_large" };
  }

  const digest = "sha256:" + bytesToHex(sha256(bytes));
  return { ok: true, canonicalJson, digest };
}

/** Recomputes the digest of an already-serialized config JSON string (the
 * `_imprintid_pricing_config` attribute). Re-parses and re-normalizes so a
 * whitespace-different but semantically identical string still verifies, and a
 * structurally invalid string fails closed. */
export function digestOfConfigJson(configJson: string): ConfigNormalizationResult {
  const bytes = utf8ToBytes(configJson);
  if (bytes.length > CART_PRICING_LIMITS.maxConfigBytes) return { ok: false, reason: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return { ok: false, reason: "unsupported_type" };
  }
  return normalizeConfig(parsed);
}
