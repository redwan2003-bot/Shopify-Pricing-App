import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * Task 5A PROOF-OF-CONCEPT ONLY — not production code, imported by nothing.
 *
 * Illustrates three properties the Task 5B "signed-quote envelope v2" design depends on
 * (see docs/architecture/task-5a-universal-cart-enforcement.md §7):
 *
 *   1. the canonical serialization is stable under object-key reordering, so the
 *      application and the (separately-implemented) Function cannot disagree on what
 *      was signed purely because they built the object in a different order;
 *   2. a digest over the *normalized* selected configuration detects a changed option
 *      id — the mechanism that binds a signed price to the exact configuration and
 *      closes the "cheap quote, expensive job" gap;
 *   3. replay/expiry can be enforced as a pure function of two integers
 *      (quote revision vs. current authoritative revision) with NO clock — which is
 *      what makes it legal inside a deterministic Shopify Function (constraint #8).
 *
 * None of this is wired into the shipping signing path; Task 5A changes no production
 * signing behavior.
 */

/** The one canonical form both runtimes already implement: sorted `key=value` joined
 * with "\n". Mirrors cart-signature.ts#canonicalizeCartPricingPayload. */
function canonical(record: Record<string, string | number>): string {
  return Object.keys(record)
    .sort()
    .map((k) => `${k}=${String(record[k])}`)
    .join("\n");
}

interface NormalizedConfig {
  decorationMethod: string | null;
  colors: number;
  locations: number;
  reverseSide: boolean;
  differentReverseArtwork: boolean;
  repeatOrder: boolean;
  productColorCode: string | null;
  optionValueIds: string[]; // sorted
  productionCode: string | null;
}

function normalizeConfig(raw: {
  decorationMethod?: string | null;
  colors?: number;
  locations?: number;
  reverseSide?: boolean;
  differentReverseArtwork?: boolean;
  repeatOrder?: boolean;
  productColorCode?: string | null;
  optionValueIds?: string[];
  productionCode?: string | null;
}): NormalizedConfig {
  return {
    decorationMethod: raw.decorationMethod ?? null,
    colors: raw.colors ?? 1,
    locations: raw.locations ?? 1,
    reverseSide: raw.reverseSide ?? false,
    differentReverseArtwork: (raw.reverseSide ?? false) && (raw.differentReverseArtwork ?? false),
    repeatOrder: raw.repeatOrder ?? false,
    productColorCode: raw.productColorCode ?? null,
    optionValueIds: [...(raw.optionValueIds ?? [])].sort(),
    productionCode: raw.productionCode ?? null,
  };
}

function configDigest(config: NormalizedConfig): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/** Clockless replay/expiry check: a quote is authoritative iff every revision it was
 * signed against still matches the current authoritative revision. Pure integers. */
function revisionsStillAuthoritative(
  quote: { profileRevision: number; policyRevision: number },
  current: { profileRevision: number; policyRevision: number },
): boolean {
  return (
    quote.profileRevision === current.profileRevision && quote.policyRevision === current.policyRevision
  );
}

test("POC 1: canonical serialization is stable under key reordering", () => {
  const a = { v: 2, productGid: "gid://shopify/Product/1", quantity: 100, unitAmountCents: 137 };
  const b = { unitAmountCents: 137, quantity: 100, v: 2, productGid: "gid://shopify/Product/1" };
  assert.equal(canonical(a), canonical(b));
  assert.equal(canonical(a), "productGid=gid://shopify/Product/1\nquantity=100\nunitAmountCents=137\nv=2");
});

test("POC 2: config digest changes when a selected option id changes, and is order-independent for option ids", () => {
  const base = normalizeConfig({ decorationMethod: "SCREEN_PRINT", colors: 1, optionValueIds: ["opt-b", "opt-a"] });
  const sameReordered = normalizeConfig({ decorationMethod: "SCREEN_PRINT", colors: 1, optionValueIds: ["opt-a", "opt-b"] });
  const changed = normalizeConfig({ decorationMethod: "SCREEN_PRINT", colors: 1, optionValueIds: ["opt-a", "opt-c"] });

  assert.equal(configDigest(base), configDigest(sameReordered), "option-id order must not change the digest");
  assert.notEqual(configDigest(base), configDigest(changed), "a changed option id must change the digest");
});

test("POC 2b: normalizeConfig clears differentReverseArtwork when reverseSide is off (matches request-body rule)", () => {
  const n = normalizeConfig({ reverseSide: false, differentReverseArtwork: true });
  assert.equal(n.differentReverseArtwork, false);
});

test("POC 3: revision check is a pure clockless function — stale profile OR policy revision fails closed", () => {
  const current = { profileRevision: 12, policyRevision: 7 };
  assert.equal(revisionsStillAuthoritative({ profileRevision: 12, policyRevision: 7 }, current), true);
  assert.equal(revisionsStillAuthoritative({ profileRevision: 11, policyRevision: 7 }, current), false, "stale profile revision");
  assert.equal(revisionsStillAuthoritative({ profileRevision: 12, policyRevision: 6 }, current), false, "stale policy revision");
});
