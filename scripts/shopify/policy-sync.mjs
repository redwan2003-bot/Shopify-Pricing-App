/**
 * Pure helpers for keeping each product's `$app:imprintid/pricing_policy` metafield in step
 * with the pricing database. The metafield carries the profile's id AND revision, and the
 * Cart Transform / Validation Functions compare the signed quote against it, so a stale
 * value (any re-import that changes pricing bumps the revision) makes valid quotes fail.
 */
import { normalizeExistingPolicyJson } from "../../app/lib/catalog/policy-value.ts";

/** How a product's stored policy compares with the one the database says it should have. */
export function classifyPolicy(expectedCanonicalJson, actualRaw) {
  if (actualRaw === null || actualRaw === undefined) return "missing";
  let value = actualRaw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return "malformed";
    }
  }
  const actualCanonical = normalizeExistingPolicyJson(value);
  if (actualCanonical === "") return "malformed";
  return actualCanonical === expectedCanonicalJson ? "ok" : "stale";
}

/** Splits matched products into those already correct and those that need a write. */
export function planPolicyWrites(matched, existingByGid, expectedFor) {
  const counts = { ok: 0, missing: 0, stale: 0, malformed: 0 };
  const toWrite = [];
  const problems = [];
  for (const m of matched) {
    const status = classifyPolicy(expectedFor(m), existingByGid.get(m.productGid));
    counts[status] += 1;
    if (status !== "ok") {
      toWrite.push(m);
      problems.push({ sku: m.profile.sku, productGid: m.productGid, status });
    }
  }
  return { counts, toWrite, problems };
}
