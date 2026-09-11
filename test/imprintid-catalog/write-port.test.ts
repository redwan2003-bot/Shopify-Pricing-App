/**
 * Task 6A.1.1 — transport-level tests for the compare-and-set contract.
 *
 * Exercises the REAL `createAdminWritePort` serialization path through the `FakeAdmin`
 * transport (which JSON-round-trips its variables, exactly reproducing what reaches
 * Shopify: an `undefined` field is DROPPED, `null` survives, `""` survives). Asserts the
 * actual outgoing `compareDigest` for replacement vs. absence, and that `""` / omission
 * are rejected.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createAdminWritePort } from "../../app/lib/catalog/write-port.ts";
import { serializeCompareDigest, ABSENT_COMPARE_DIGEST } from "../../app/lib/catalog/admin-client.ts";
import { canonicalPolicyJson, buildProductPolicyValue } from "../../app/lib/catalog/policy-value.ts";
import { FakeAdmin } from "./fake-admin.ts";

const DESIRED = canonicalPolicyJson(buildProductPolicyValue({ profileId: "p1", profileRevision: 1, policyRevision: 1 }));

after(() => {
  /* no shared DB state */
});

test("ABSENT_COMPARE_DIGEST is literal null (never the empty string)", () => {
  assert.equal(ABSENT_COMPARE_DIGEST, null);
  assert.notEqual(ABSENT_COMPARE_DIGEST as unknown, "");
});

test("serializeCompareDigest: string passes through, null → null, '' throws", () => {
  assert.equal(serializeCompareDigest("dg_abc"), "dg_abc");
  assert.equal(serializeCompareDigest(null), null);
  assert.equal(serializeCompareDigest(undefined), null);
  assert.throws(() => serializeCompareDigest(""), /never ""/);
});

test("replacement sends the exact digest string as compareDigest", async () => {
  const admin = new FakeAdmin();
  const gid = "gid://shopify/Product/1001";
  const seededDigest = admin.seedMetafield(gid, DESIRED);
  const port = createAdminWritePort(admin);

  const out = await port.setProductPolicies([{ productGid: gid, valueJson: DESIRED, compareDigest: seededDigest }]);
  assert.equal(out.get(gid)?.ok, true);

  const sent = admin.lastSetVariables!.metafields[0]!;
  assert.ok("compareDigest" in sent, "the compareDigest key is present");
  assert.equal(sent.compareDigest, seededDigest, "the exact returned digest string is sent");
  assert.equal(typeof sent.compareDigest, "string");
});

test("creation/absence sends JSON null as compareDigest — never '', never omitted", async () => {
  const admin = new FakeAdmin();
  const gid = "gid://shopify/Product/1002"; // no metafield seeded → absent
  const port = createAdminWritePort(admin);

  const out = await port.setProductPolicies([{ productGid: gid, valueJson: DESIRED, compareDigest: null }]);
  assert.equal(out.get(gid)?.ok, true, "an absence assertion against a truly-absent metafield succeeds");

  const sent = admin.lastSetVariables!.metafields[0]!;
  assert.ok("compareDigest" in sent, "the compareDigest key is PRESENT (not omitted)");
  assert.equal(sent.compareDigest, null, "the value is literal JSON null");
  assert.notEqual(sent.compareDigest, "", "the value is NOT the empty string");
  assert.notEqual(sent.compareDigest, undefined, "the value is NOT undefined");

  // Prove the round-trip really captured a serialized `null`, not a dropped key.
  const wire = JSON.stringify(admin.lastSetVariables);
  assert.match(wire, /"compareDigest":null/);
});

test("a mixed batch sends a digest for the present one and null for the absent one", async () => {
  const admin = new FakeAdmin();
  const present = "gid://shopify/Product/2001";
  const absent = "gid://shopify/Product/2002";
  const d = admin.seedMetafield(present, DESIRED);
  const port = createAdminWritePort(admin);

  await port.setProductPolicies([
    { productGid: present, valueJson: DESIRED, compareDigest: d },
    { productGid: absent, valueJson: DESIRED, compareDigest: null },
  ]);

  const byOwner = new Map(admin.lastSetVariables!.metafields.map((m) => [m.ownerId as string, m.compareDigest]));
  assert.equal(byOwner.get(present), d);
  assert.equal(byOwner.get(absent), null);
});

test("the FakeAdmin transport HARD-REJECTS a '' compareDigest (regression guard)", async () => {
  const admin = new FakeAdmin();
  await assert.rejects(
    () =>
      admin.graphql("mutation ImprintIdSetProductPolicy", {
        variables: {
          metafields: [{ ownerId: "gid://shopify/Product/3001", namespace: "$app:imprintid", key: "pricing_policy", type: "json", value: DESIRED, compareDigest: "" }],
        },
      }),
    /sent compareDigest: ""/,
  );
});

test("the FakeAdmin transport HARD-REJECTS an omitted compareDigest (blind overwrite)", async () => {
  const admin = new FakeAdmin();
  await assert.rejects(
    () =>
      admin.graphql("mutation ImprintIdSetProductPolicy", {
        variables: {
          metafields: [{ ownerId: "gid://shopify/Product/3002", namespace: "$app:imprintid", key: "pricing_policy", type: "json", value: DESIRED }],
        },
      }),
    /OMITTED compareDigest/,
  );
});

test("the write port THROWS before any network call if a caller smuggles in '' — never a retry loop", async () => {
  const admin = new FakeAdmin();
  const port = createAdminWritePort(admin);
  const badRequest = { productGid: "gid://shopify/Product/4001", valueJson: DESIRED, compareDigest: "" as string | null };
  await assert.rejects(() => port.setProductPolicies([badRequest]), /never ""/);
  // The guard runs up front, OUTSIDE the try/catch, so nothing was sent to Shopify.
  assert.equal(admin.calls.filter((c) => c.op === "setPolicies").length, 0);
});

test("an absence assertion against a metafield that now EXISTS is a conflict, not an overwrite", async () => {
  const admin = new FakeAdmin();
  const gid = "gid://shopify/Product/5001";
  admin.seedMetafield(gid, JSON.stringify({ schema: 1, required: true, active: true, profileRef: "other", profileRevision: 9, policyRevision: 9 }));
  const before = admin.metafields.get(gid)!.json;
  const port = createAdminWritePort(admin);

  const out = await port.setProductPolicies([{ productGid: gid, valueJson: DESIRED, compareDigest: null }]);
  const outcome = out.get(gid)!;
  assert.equal(outcome.ok, false);
  assert.ok("conflict" in outcome && outcome.conflict);
  assert.equal(admin.metafields.get(gid)!.json, before, "the existing value was NOT overwritten");
});
