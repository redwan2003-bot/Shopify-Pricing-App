import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPolicy, planPolicyWrites } from "../../scripts/shopify/policy-sync.mjs";
import { buildProductPolicyValue, canonicalPolicyJson } from "../../app/lib/catalog/policy-value.ts";

const expected = (profileId: string, revision: number) =>
  canonicalPolicyJson(buildProductPolicyValue({ profileId, profileRevision: revision, policyRevision: 1 }));

test("classifyPolicy: identical value is ok, whether it arrives as a JSON string or an object", () => {
  const json = expected("prof_a", 2);
  assert.equal(classifyPolicy(json, json), "ok");
  assert.equal(classifyPolicy(json, JSON.parse(json)), "ok");
});

test("classifyPolicy: a bumped profile revision is stale, not ok", () => {
  assert.equal(classifyPolicy(expected("prof_a", 2), expected("prof_a", 1)), "stale");
});

test("classifyPolicy: a different profile id is stale", () => {
  assert.equal(classifyPolicy(expected("prof_a", 1), expected("prof_b", 1)), "stale");
});

test("classifyPolicy: absent, unparseable, and wrongly-shaped values", () => {
  const json = expected("prof_a", 1);
  assert.equal(classifyPolicy(json, null), "missing");
  assert.equal(classifyPolicy(json, undefined), "missing");
  assert.equal(classifyPolicy(json, "{not json"), "malformed");
  assert.equal(classifyPolicy(json, { schema: 1 }), "malformed");
});

test("planPolicyWrites only queues products whose policy is not already correct", () => {
  const matched = [
    { productGid: "gid://shopify/Product/1", profile: { id: "p1", sku: "A", revision: 2 } },
    { productGid: "gid://shopify/Product/2", profile: { id: "p2", sku: "B", revision: 2 } },
    { productGid: "gid://shopify/Product/3", profile: { id: "p3", sku: "C", revision: 2 } },
    { productGid: "gid://shopify/Product/4", profile: { id: "p4", sku: "D", revision: 2 } },
  ];
  const existing = new Map<string, unknown>([
    ["gid://shopify/Product/1", expected("p1", 2)], // ok
    ["gid://shopify/Product/2", expected("p2", 1)], // stale revision
    ["gid://shopify/Product/3", null], // missing
    ["gid://shopify/Product/4", "garbage"], // malformed
  ]);
  const plan = planPolicyWrites(matched, existing, (m: { profile: { id: string; revision: number } }) => expected(m.profile.id, m.profile.revision));
  assert.deepEqual(plan.counts, { ok: 1, missing: 1, stale: 1, malformed: 1 });
  assert.deepEqual(plan.toWrite.map((m) => m.profile.sku), ["B", "C", "D"]);
  assert.deepEqual(plan.problems.map((p) => p.status), ["stale", "missing", "malformed"]);
});
