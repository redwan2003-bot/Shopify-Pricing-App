import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createTestPrisma } from "../../../test/support/prisma.ts";
import type { AdminGraphqlClientLike } from "../pricing-api/product-resolver.ts";
import { buildProductPolicyValue, canonicalPolicyJson } from "../catalog/policy-value.ts";
import { DIGEST_MISMATCH_CODE } from "../catalog/admin-client.ts";
import { buildLinkReport, summarizeLinkReport } from "./link-products.ts";
import { applySkuLinkPlan, buildSkuLinkPlan, checkContract, diffAgainstPreview, rollbackSkuLink, type Manifest } from "./sku-link-apply.ts";

/**
 * The guarded SKU-link apply, against a fake Shopify with REAL compare-and-set digests and a
 * log of every call, so "no write", "manifest first" and "stop on drift" are checked for real.
 */

const prisma = createTestPrisma();
const SUFFIX = `${process.pid}-${Date.now()}`;
const stores: string[] = [];

after(async () => {
  for (const id of stores) {
    await prisma.productPricingOverride.deleteMany({ where: { storeId: id } });
    await prisma.pricingProfile.deleteMany({ where: { storeId: id } });
    await prisma.store.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

interface FakeProduct {
  id: number;
  title: string;
  status: "ACTIVE" | "ARCHIVED" | "DRAFT";
  skus: string[];
}

class FakeShopify implements AdminGraphqlClientLike {
  domain: string;
  products: FakeProduct[];
  policies = new Map<string, { value: string; version: number }>();
  events: string[] = [];
  /** runs just before a metafieldsSet is applied (to simulate a concurrent change) */
  beforeSet?: (ownerIds: string[]) => void;
  constructor(domain: string, products: FakeProduct[]) {
    this.domain = domain;
    this.products = products;
  }
  digest(gid: string) {
    const p = this.policies.get(gid);
    return p ? `dg-${gid.split("/").pop()}-v${p.version}` : null;
  }
  setPolicy(gid: string, value: string) {
    const cur = this.policies.get(gid);
    this.policies.set(gid, { value, version: (cur?.version ?? 0) + 1 });
  }
  mutations() {
    return this.events.filter((e) => e.startsWith("mutation")).length;
  }
  async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
    const vars = options?.variables ?? {};
    let data: Record<string, unknown>;
    if (query.includes("ImprintIdSkuIndex")) {
      data = {
        products: {
          edges: this.products.map((p) => ({
            cursor: `c${p.id}`,
            node: { id: `gid://shopify/Product/${p.id}`, title: p.title, status: p.status, variants: { edges: p.skus.map((sku) => ({ node: { sku } })) } },
          })),
          pageInfo: { hasNextPage: false },
        },
      };
    } else if (query.includes("ImprintIdPolicyRead")) {
      data = { nodes: (vars.ids as string[]).map((id) => ({ id, metafield: this.policies.has(id) ? { value: this.policies.get(id)!.value } : null })) };
    } else if (query.includes("ImprintIdProductPolicies")) {
      data = {
        nodes: (vars.ids as string[]).map((id) => {
          const p = this.policies.get(id);
          return { __typename: "Product", id, metafield: p ? { id: `mf-${id}`, type: "json", value: p.value, jsonValue: JSON.parse(p.value), compareDigest: this.digest(id) } : null };
        }),
      };
    } else if (query.includes("ImprintIdProductStatus")) {
      data = { nodes: (vars.ids as string[]).map((id) => ({ __typename: "Product", id, status: this.products.find((p) => `gid://shopify/Product/${p.id}` === id)?.status })) };
    } else if (query.includes("ImprintIdShopIdentity")) {
      data = { shop: { myshopifyDomain: this.domain } };
    } else if (query.includes("ImprintIdSetProductPolicy")) {
      const inputs = vars.metafields as { ownerId: string; value: string; compareDigest: string | null }[];
      this.beforeSet?.(inputs.map((i) => i.ownerId));
      const userErrors: { code: string; message: string; elementIndex: number }[] = [];
      const done: { id: string; owner: { id: string }; compareDigest: string | null }[] = [];
      inputs.forEach((input, index) => {
        const current = this.digest(input.ownerId);
        if (input.compareDigest !== current) {
          userErrors.push({ code: DIGEST_MISMATCH_CODE, message: "digest mismatch", elementIndex: index });
          return;
        }
        this.setPolicy(input.ownerId, input.value);
        this.events.push(`mutation:set:${input.ownerId.split("/").pop()}`);
        done.push({ id: `mf-${input.ownerId}`, owner: { id: input.ownerId }, compareDigest: this.digest(input.ownerId) });
      });
      data = { metafieldsSet: { metafields: done, userErrors } };
    } else if (query.includes("ImprintIdDeleteProductPolicy")) {
      const inputs = vars.metafields as { ownerId: string }[];
      for (const i of inputs) {
        this.policies.delete(i.ownerId);
        this.events.push(`mutation:delete:${i.ownerId.split("/").pop()}`);
      }
      data = { metafieldsDelete: { deletedMetafields: inputs, userErrors: [] } };
    } else {
      throw new Error(`unexpected GraphQL document: ${query.slice(0, 70)}`);
    }
    return { json: async () => ({ data }) } as unknown as Awaited<ReturnType<AdminGraphqlClientLike["graphql"]>>;
  }
}

/** n products 9000001.. with SKUs P0001.., and one profile each, created with a single insert. */
async function fixture(n: number) {
  const shop = `sku-apply-${SUFFIX}-${stores.length}.invalid`;
  const store = await prisma.store.create({ data: { shopDomain: shop } });
  stores.push(store.id);
  const skus = Array.from({ length: n }, (_, i) => `P${String(i + 1).padStart(4, "0")}`);
  await prisma.pricingProfile.createMany({ data: skus.map((sku) => ({ storeId: store.id, name: `Profile ${sku}`, sku })) });
  const profiles = await prisma.pricingProfile.findMany({ where: { storeId: store.id }, select: { id: true, sku: true } });
  const profileId = new Map(profiles.map((p) => [p.sku!, p.id]));
  const products: FakeProduct[] = skus.map((sku, i) => ({ id: 9_000_001 + i, title: `${sku} product`, status: "ACTIVE", skus: [`${sku}_Red`] }));
  return { shop, storeId: store.id, skus, profileId, shopify: new FakeShopify(shop, products), products };
}

const gid = (n: number) => `gid://shopify/Product/${n}`;
const bareOverrides = async (storeId: string) =>
  (await prisma.productPricingOverride.findMany({ where: { storeId }, select: { shopifyProductId: true }, orderBy: { shopifyProductId: "asc" } })).map((r) => r.shopifyProductId);

function runApply(f: Awaited<ReturnType<typeof fixture>>, hash: string, hooks: { onManifest?: (m: Manifest) => Promise<void> } = {}) {
  const manifests: Manifest[] = [];
  return {
    manifests,
    promise: applySkuLinkPlan({
      prisma,
      admin: f.shopify,
      shop: f.shop,
      storeId: f.storeId,
      resolutions: {},
      approvedHash: hash,
      onManifest: async (m) => {
        f.shopify.events.push(`manifest:${m.state}`);
        manifests.push(JSON.parse(JSON.stringify(m)));
        await hooks.onManifest?.(m);
      },
    }),
  };
}

const planOf = (f: Awaited<ReturnType<typeof fixture>>) => buildSkuLinkPlan({ prisma, admin: f.shopify, shop: f.shop, storeId: f.storeId, resolutions: {} });

test("plan mode writes nothing and its hash tracks every live fact it depends on", async () => {
  const f = await fixture(3);
  const a = await planOf(f);
  const b = await planOf(f);
  assert.equal(a.hash, b.hash, "the same live state gives the same hash");
  assert.equal(f.shopify.mutations(), 0);
  assert.equal(f.shopify.policies.size, 0);
  assert.deepEqual(await bareOverrides(f.storeId), []);
  assert.equal(a.totals.matched, 3);
  assert.equal(a.totals.missing, 3);
  assert.equal(a.totals.overridesToCreate, 3);

  f.shopify.setPolicy(gid(9_000_002), JSON.stringify({ unrelated: true })); // a metafield appears
  const c = await planOf(f);
  assert.notEqual(c.hash, a.hash, "a changed metafield changes the plan hash");
  f.shopify.policies.clear();
  f.products[0].status = "ARCHIVED"; // the product becomes archived-only
  const d = await planOf(f);
  assert.notEqual(d.hash, a.hash, "a changed product changes the plan hash");
});

test("the contract and a saved preview are compared list by list, not just by count", async () => {
  const f = await fixture(4);
  const plan = await planOf(f);
  const preview = JSON.parse(JSON.stringify(summarizeLinkReport(await buildLinkReport(prisma, f.shopify, f.storeId))));

  assert.deepEqual(diffAgainstPreview(plan, preview), [], "identical to its own preview");
  preview.matched[0].productId = "1"; // same counts, different product
  assert.ok(diffAgainstPreview(plan, preview).some((p) => /matched/.test(p)));

  const contract = { matched: 4, heldBackSkus: [], staleWrites: 0, missingWrites: 4, overridesToCreate: 4, overridesUnchanged: 0, blocked: 0, legacyGidRows: 0 };
  assert.deepEqual(checkContract(plan, contract), []);
  assert.ok(checkContract(plan, { ...contract, matched: 5 }).some((p) => /matched/.test(p)));
  assert.ok(checkContract(plan, { ...contract, heldBackSkus: ["X"] }).some((p) => /held back/.test(p)));
});

test("apply: writes the manifest BEFORE the first mutation, then policies and bare-keyed overrides, across batches", async () => {
  const f = await fixture(27); // 25 + 2: two batches
  // 5 stale policies (an older revision) and one already-correct bare override.
  for (let i = 0; i < 5; i++) {
    const id = f.profileId.get(f.skus[i])!;
    f.shopify.setPolicy(gid(9_000_001 + i), canonicalPolicyJson(buildProductPolicyValue({ profileId: id, profileRevision: 0, policyRevision: 1 })));
  }
  await prisma.productPricingOverride.create({ data: { storeId: f.storeId, shopifyProductId: "9000001", pricingProfileId: f.profileId.get("P0001"), isActive: true } });

  const plan = await planOf(f);
  assert.equal(plan.totals.stale, 5);
  assert.equal(plan.totals.missing, 22);
  assert.equal(plan.totals.overridesUnchanged, 1);
  assert.equal(plan.totals.overridesToCreate, 26);

  const run = runApply(f, plan.hash);
  const result = await run.promise;

  assert.equal(result.state, "completed", JSON.stringify(result.abortedBecause ?? result.refusedBecause));
  assert.equal(f.shopify.events[0], "manifest:planned", "the manifest was written before any mutation");
  assert.equal(f.shopify.events.findIndex((e) => e.startsWith("mutation")) > 0, true);
  assert.equal(result.policiesWritten, 27);
  assert.equal(result.overridesCreated, 26);
  assert.equal((await bareOverrides(f.storeId)).length, 27, "26 created + 1 pre-existing, none duplicated, none GID-keyed");
  assert.ok((await bareOverrides(f.storeId)).every((k) => /^\d+$/.test(k)));
  for (const e of plan.entries) assert.equal(f.shopify.policies.get(e.productGid)?.value, e.expectedPolicy, "the stored policy is exactly the planned one");
  const last = run.manifests[run.manifests.length - 1];
  assert.equal(last.state, "completed");
  assert.ok(last.entries.every((e) => e.status === "done"));
  assert.ok(last.entries.filter((e) => e.policyWritten).every((e) => typeof e.digestAfter === "string"), "the digest after the write is recorded for rollback");
  assert.ok(run.manifests.length >= 3, "the manifest was updated after each batch");
});

test("apply refuses, and writes nothing, if the approved plan no longer matches the live state", async () => {
  const f = await fixture(3);
  const plan = await planOf(f);
  f.shopify.setPolicy(gid(9_000_001), JSON.stringify({ someone: "else" })); // a merchant edit after approval
  const result = await runApply(f, plan.hash).promise;
  assert.equal(result.state, "aborted");
  assert.match(String(result.refusedBecause), /no longer matches the approved plan/);
  assert.equal(f.shopify.mutations(), 0);
  assert.equal(f.shopify.events.includes("manifest:planned"), false, "not even a manifest");
  assert.deepEqual(await bareOverrides(f.storeId), []);
});

test("apply refuses for a different shop than the confirmed one", async () => {
  const f = await fixture(2);
  const plan = await planOf(f);
  f.shopify.domain = "some-other-shop.myshopify.com";
  const result = await runApply(f, plan.hash).promise;
  assert.equal(result.state, "aborted");
  assert.match(String(result.refusedBecause), /different shop/);
  assert.equal(f.shopify.mutations(), 0);
});

test("apply stops before a batch if a product was archived since the plan, leaving later batches untouched", async () => {
  const f = await fixture(26); // batch 1 = 25 products, batch 2 = the last one
  const plan = await planOf(f);
  const run = runApply(f, plan.hash, {
    onManifest: async () => {
      // after the first batch is recorded, the last product is archived in Shopify
      if (f.shopify.mutations() > 0) f.products[25].status = "ARCHIVED";
    },
  });
  const result = await run.promise;

  assert.equal(result.state, "aborted");
  assert.match(String(result.abortedBecause), /not ACTIVE/);
  assert.equal(result.policiesWritten, 25);
  assert.equal(f.shopify.policies.has(gid(9_000_026)), false, "the archived product got no policy");
  assert.equal((await bareOverrides(f.storeId)).length, 25);
  const last = run.manifests[run.manifests.length - 1];
  assert.equal(last.state, "aborted");
  assert.equal(last.entries.find((e) => e.productId === "9000026")?.status, "skipped");
});

test("apply stops if a profile revision changed or an override appeared since the plan", async () => {
  const f = await fixture(26);
  const plan = await planOf(f);
  let bumped = false;
  const run = runApply(f, plan.hash, {
    onManifest: async () => {
      if (f.shopify.mutations() > 0 && !bumped) {
        bumped = true;
        await prisma.pricingProfile.update({ where: { id: f.profileId.get("P0026")! }, data: { revision: { increment: 1 } } });
      }
    },
  });
  const result = await run.promise;
  assert.equal(result.state, "aborted");
  assert.match(String(result.abortedBecause), /profile revision changed/);
  assert.equal(f.shopify.policies.has(gid(9_000_026)), false);

  const g = await fixture(26);
  const planG = await planOf(g);
  let planted = false;
  const runG = runApply(g, planG.hash, {
    onManifest: async () => {
      if (g.shopify.mutations() > 0 && !planted) {
        planted = true;
        await prisma.productPricingOverride.create({ data: { storeId: g.storeId, shopifyProductId: "9000026", pricingProfileId: g.profileId.get("P0026"), isActive: true } });
      }
    },
  });
  const resultG = await runG.promise;
  assert.equal(resultG.state, "aborted");
  assert.match(String(resultG.abortedBecause), /bare-keyed override already exists/);
  assert.equal(g.shopify.policies.has(gid(9_000_026)), false);
});

test("a metafield changed at the very moment of the write is a conflict: it is preserved, not overwritten", async () => {
  const f = await fixture(3);
  const plan = await planOf(f);
  const theirs = JSON.stringify({ merchant: "edit" });
  f.shopify.beforeSet = () => {
    f.shopify.setPolicy(gid(9_000_002), theirs); // changes after verification, before the compare-and-set
    f.shopify.beforeSet = undefined;
  };
  const run = runApply(f, plan.hash);
  const result = await run.promise;

  assert.equal(result.state, "aborted");
  assert.equal(f.shopify.policies.get(gid(9_000_002))?.value, theirs, "the concurrent change is preserved");
  assert.equal((await bareOverrides(f.storeId)).includes("9000002"), false, "no override for the product whose write conflicted");
  const failed = run.manifests[run.manifests.length - 1].entries.find((e) => e.productId === "9000002");
  assert.equal(failed?.status, "failed");
  assert.match(String(failed?.error), /CONFLICT_DIGEST_MISMATCH/);
});

test("a conflicting legacy GID-keyed override blocks the whole apply before any write", async () => {
  const f = await fixture(3);
  const other = (await prisma.pricingProfile.create({ data: { storeId: f.storeId, name: "Other", sku: "OTHER" } })).id;
  await prisma.productPricingOverride.create({ data: { storeId: f.storeId, shopifyProductId: gid(9_000_002), pricingProfileId: other, isActive: true } });
  const plan = await planOf(f);
  assert.equal(plan.totals.blocked, 1);
  const result = await runApply(f, plan.hash).promise;
  assert.equal(result.state, "aborted");
  assert.match(String(result.refusedBecause), /blocked by override-key conflicts/);
  assert.equal(f.shopify.mutations(), 0);
});

test("rollback restores previous values, removes what the run created, and leaves anything changed since", async () => {
  const f = await fixture(4);
  const staleValue = canonicalPolicyJson(buildProductPolicyValue({ profileId: f.profileId.get("P0001")!, profileRevision: 0, policyRevision: 1 }));
  f.shopify.setPolicy(gid(9_000_001), staleValue); // P0001 stale; P0002-4 missing
  await prisma.productPricingOverride.create({ data: { storeId: f.storeId, shopifyProductId: "9000001", pricingProfileId: f.profileId.get("P0001"), isActive: true } });

  const plan = await planOf(f);
  const run = runApply(f, plan.hash);
  const applied = await run.promise;
  assert.equal(applied.state, "completed");
  const manifest = run.manifests[run.manifests.length - 1];

  // After the apply a merchant edits P0004's policy: rollback must not touch it.
  f.shopify.setPolicy(gid(9_000_004), JSON.stringify({ merchant: "edit after apply" }));

  const rolled = await rollbackSkuLink({ prisma, admin: f.shopify, shop: f.shop, storeId: f.storeId, manifest, onManifest: async () => {} });
  assert.equal(rolled.restored, 1, "P0001's previous stale value is restored");
  assert.equal(JSON.parse(f.shopify.policies.get(gid(9_000_001))!.value).profileRevision, 0);
  assert.equal(rolled.removedMetafields, 2, "P0002 and P0003 had no metafield before, so it is removed");
  assert.equal(f.shopify.policies.has(gid(9_000_002)), false);
  assert.equal(f.shopify.policies.has(gid(9_000_003)), false);
  assert.equal(JSON.parse(f.shopify.policies.get(gid(9_000_004))!.value).merchant, "edit after apply", "a later merchant change is left alone");
  assert.equal(rolled.skipped.length, 1);
  assert.deepEqual(await bareOverrides(f.storeId), ["9000001"], "only the pre-existing override remains; the ones the run created are gone");
  assert.equal(manifest.state, "rolled_back");
});
