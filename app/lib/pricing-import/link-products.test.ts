import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createTestPrisma } from "../../../test/support/prisma.ts";
import type { AdminGraphqlClientLike } from "../pricing-api/product-resolver.ts";
import { applyLinkReport, buildLinkReport, expectedPolicyJson, summarizeLinkReport } from "./link-products.ts";

/**
 * SKU auto-link: bare-key overrides, a read-only preview, idempotency, legacy GID-keyed row
 * protection, archived exclusion and explicit manual resolutions. A fake Shopify serves the
 * SKU index and the policy metafield and records every call, so "no write" is checked for real.
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
  mutations = 0;
  policies = new Map<string, string>();
  products: FakeProduct[];
  constructor(products: FakeProduct[]) {
    this.products = products;
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
      data = {
        nodes: (vars.ids as string[]).map((id) => ({ id, metafield: this.policies.has(id) ? { value: this.policies.get(id) } : null })),
      };
    } else if (query.includes("ImprintIdPolicyWrite")) {
      this.mutations += 1;
      const input = vars.metafields as { ownerId: string; value: string }[];
      for (const m of input) this.policies.set(m.ownerId, m.value);
      data = { metafieldsSet: { metafields: input.map((m) => ({ id: `m-${m.ownerId}` })), userErrors: [] } };
    } else {
      throw new Error(`unexpected GraphQL document: ${query.slice(0, 60)}`);
    }
    return { json: async () => ({ data }) } as unknown as Awaited<ReturnType<AdminGraphqlClientLike["graphql"]>>;
  }
}

async function fixture(skus: string[]) {
  const store = await prisma.store.create({ data: { shopDomain: `link-test-${SUFFIX}-${stores.length}.invalid` } });
  stores.push(store.id);
  const profiles: Record<string, string> = {};
  for (const sku of skus) {
    profiles[sku] = (await prisma.pricingProfile.create({ data: { storeId: store.id, name: `Profile ${sku}`, sku } })).id;
  }
  return { storeId: store.id, profiles };
}

const gid = (id: number) => `gid://shopify/Product/${id}`;
const overrideKeys = async (storeId: string) =>
  (await prisma.productPricingOverride.findMany({ where: { storeId }, select: { shopifyProductId: true }, orderBy: { shopifyProductId: "asc" } })).map((r) => r.shopifyProductId);

test("apply writes BARE-keyed overrides and never a GID-keyed one", async () => {
  const { storeId } = await fixture(["AAA", "BBB"]);
  const shop = new FakeShopify([
    { id: 1001, title: "AAA thing", status: "ACTIVE", skus: ["AAA_Red", "AAA_Blue"] },
    { id: 1002, title: "BBB thing", status: "ACTIVE", skus: ["BBB_Red"] },
  ]);
  const report = await buildLinkReport(prisma, shop, storeId);
  const applied = await applyLinkReport(prisma, shop, storeId, report);

  assert.deepEqual(await overrideKeys(storeId), ["1001", "1002"], "keys are the bare numeric ids");
  assert.equal(applied.overridesCreated, 2);
  assert.equal(applied.written, 2, "one Shopify policy write per matched product");
  assert.ok((await overrideKeys(storeId)).every((k) => !k.startsWith("gid://")));
});

test("the preview is read-only: no Shopify mutation and no local override write", async () => {
  const { storeId } = await fixture(["AAA", "BBB"]);
  const shop = new FakeShopify([
    { id: 2001, title: "AAA", status: "ACTIVE", skus: ["AAA_x"] },
    { id: 2002, title: "BBB", status: "ACTIVE", skus: ["BBB_x"] },
  ]);
  const report = await buildLinkReport(prisma, shop, storeId);
  const summary = summarizeLinkReport(report);

  assert.equal(shop.mutations, 0, "no metafield was written");
  assert.equal(shop.policies.size, 0);
  assert.deepEqual(await overrideKeys(storeId), [], "no override was written");
  assert.equal(summary.totals.matched, 2);
  assert.equal(summary.totals.shopifyPolicyWrites, 2, "the preview reports the writes it would make");
  assert.equal(summary.totals.overridesToCreate, 2);
  assert.deepEqual(summary.proposedOverrideChanges.map((c) => c.key).sort(), ["2001", "2002"]);
  assert.deepEqual(summary.matched.map((m) => m.productId).sort(), ["2001", "2002"]);
});

test("an existing bare-keyed override is preserved: no duplicate, and re-applying is idempotent", async () => {
  const { storeId, profiles } = await fixture(["AAA"]);
  await prisma.productPricingOverride.create({ data: { storeId, shopifyProductId: "3001", pricingProfileId: profiles.AAA, isActive: true } });
  const shop = new FakeShopify([{ id: 3001, title: "AAA", status: "ACTIVE", skus: ["AAA_x"] }]);

  const first = await buildLinkReport(prisma, shop, storeId);
  assert.equal(first.overridePlan[0].action, "unchanged", "the existing row already matches");
  await applyLinkReport(prisma, shop, storeId, first);
  assert.deepEqual(await overrideKeys(storeId), ["3001"], "still exactly one row, bare-keyed");

  const second = await buildLinkReport(prisma, shop, storeId);
  const applied = await applyLinkReport(prisma, shop, storeId, second);
  assert.equal(applied.written, 0, "the Shopify policy is already correct, so nothing is rewritten");
  assert.equal(applied.overridesCreated + applied.overridesUpdated, 0);
  assert.deepEqual(await overrideKeys(storeId), ["3001"]);
  assert.equal(shop.policies.get(gid(3001)), expectedPolicyJson(second.matched[0]), "the stored policy is the expected one");
});

test("an existing bare-keyed override pointing at another profile is reported as an update, not hidden", async () => {
  const { storeId, profiles } = await fixture(["AAA", "OLD"]);
  await prisma.productPricingOverride.create({ data: { storeId, shopifyProductId: "3501", pricingProfileId: profiles.OLD, isActive: true } });
  const shop = new FakeShopify([{ id: 3501, title: "AAA", status: "ACTIVE", skus: ["AAA_x"] }]);
  const report = await buildLinkReport(prisma, shop, storeId);
  const entry = report.overridePlan[0];
  assert.equal(entry.action, "update");
  assert.equal(entry.fromProfileId, profiles.OLD);
  assert.equal(summarizeLinkReport(report).proposedOverrideChanges[0].replacesProfileId, profiles.OLD);
  assert.equal(await prisma.productPricingOverride.count({ where: { storeId, pricingProfileId: profiles.OLD } }), 1, "the preview changed nothing");
});

test("legacy GID-keyed rows: an identical one is left untouched, a conflicting one blocks the product", async () => {
  const { storeId, profiles } = await fixture(["AAA", "CCC"]);
  // Product 4001: legacy GID row that agrees with what we would write.
  await prisma.productPricingOverride.create({ data: { storeId, shopifyProductId: gid(4001), pricingProfileId: profiles.AAA, isActive: true } });
  // Product 4002: legacy GID row pointing at a DIFFERENT profile.
  await prisma.productPricingOverride.create({ data: { storeId, shopifyProductId: gid(4002), pricingProfileId: profiles.AAA, isActive: true } });
  const shop = new FakeShopify([
    { id: 4001, title: "AAA", status: "ACTIVE", skus: ["AAA_x"] },
    { id: 4002, title: "CCC", status: "ACTIVE", skus: ["CCC_x"] },
  ]);

  const report = await buildLinkReport(prisma, shop, storeId);
  const byKey = new Map(report.overridePlan.map((e) => [e.bareKey, e]));
  assert.equal(byKey.get("4001")?.action, "create");
  assert.equal(byKey.get("4001")?.legacyGidRow, true);
  assert.equal(byKey.get("4002")?.action, "blocked");
  assert.equal(report.blocked.length, 1);
  assert.equal(report.toWrite.some((m) => m.productGid === gid(4002)), false, "no Shopify policy write for a blocked product");

  await applyLinkReport(prisma, shop, storeId, report);
  assert.deepEqual(await overrideKeys(storeId), ["4001", gid(4001), gid(4002)].sort(), "bare row added only for 4001; both legacy rows untouched; none for 4002");
  assert.equal(shop.policies.has(gid(4002)), false);
  assert.equal(shop.policies.has(gid(4001)), true);
});

test("archived products are not candidates and an explicit product id resolves a real ambiguity", async () => {
  const { storeId } = await fixture(["LPY12", "LDSBR34", "LDUSY", "ZZZ"]);
  const shop = new FakeShopify([
    { id: 5001, title: "LPY12 real", status: "ACTIVE", skus: ["LPY12_White"] },
    { id: 5002, title: "LPY12 old test", status: "ARCHIVED", skus: ["LPY12_White"] },
    { id: 5003, title: "generic 3/4 lanyard", status: "ACTIVE", skus: ["LDSBR34_White"] },
    { id: 5004, title: "LDSBR34 3/4 lanyard", status: "ACTIVE", skus: ["LDSBR34_White"] },
    { id: 5005, title: "LDUSY youth", status: "ARCHIVED", skus: ["LDUSY_White"] },
  ]);

  const plain = await buildLinkReport(prisma, shop, storeId);
  assert.deepEqual(plain.matched.map((m) => m.profile.sku), ["LPY12"], "the archived twin does not make LPY12 ambiguous");
  const reasons = new Map(plain.heldBack.map((h) => [h.sku, h.reason]));
  assert.match(reasons.get("LDSBR34") ?? "", /ambiguous/);
  assert.match(reasons.get("LDUSY") ?? "", /only archived/);
  assert.match(reasons.get("ZZZ") ?? "", /no product/);

  const resolved = await buildLinkReport(prisma, shop, storeId, { manualResolutions: { LDSBR34: "5004" } });
  const ldsbr = resolved.matched.find((m) => m.profile.sku === "LDSBR34");
  assert.equal(ldsbr?.productGid, gid(5004), "the explicitly chosen product, by id");
  assert.equal(ldsbr?.manual, true);
  assert.equal(summarizeLinkReport(resolved).matched.find((m) => m.sku === "LDSBR34")?.manualResolution, true);

  const wrong = await buildLinkReport(prisma, shop, storeId, { manualResolutions: { LDSBR34: "9999", LDUSY: "5005" } });
  const wrongReasons = new Map(wrong.heldBack.map((h) => [h.sku, h.reason]));
  assert.match(wrongReasons.get("LDSBR34") ?? "", /does not carry this SKU/);
  assert.match(wrongReasons.get("LDUSY") ?? "", /is archived/);
  assert.equal(wrong.matched.some((m) => m.profile.sku === "LDSBR34" || m.profile.sku === "LDUSY"), false);
});
