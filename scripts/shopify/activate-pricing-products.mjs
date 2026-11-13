import { connectAdmin, createScriptPrismaClient } from "./runtime.mjs";

const SHOP = "imprintid-pricing-dev.myshopify.com";
const APP_NS = "$app:imprintid";
const POLICY_KEY = "pricing_policy";
const EXPECTED_COUNT = 145;
const APPLY = process.argv.includes("--apply");

const chunks = (items, size) => {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

function canonicalPolicy({ profileRef, profileRevision, policyRevision }) {
  return JSON.stringify({
    schema: 1,
    required: true,
    active: true,
    profileRef,
    profileRevision,
    policyRevision,
  });
}

function parsePolicy(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("policy is not an object");
  return parsed;
}

async function readShopPolicy(gql) {
  const data = await gql(`
    query PricingActivationShopPolicy {
      shop {
        currencyCode
        metafield(namespace: "${APP_NS}", key: "enforcement_policy") { jsonValue }
      }
    }
  `);
  const policy = parsePolicy(data.shop?.metafield?.jsonValue);
  if (policy.schema !== 1 || policy.enabled !== true || !["pilot", "universal"].includes(policy.mode)) {
    throw new Error("shop enforcement policy is not enabled in pilot/universal mode");
  }
  if (!Number.isSafeInteger(policy.policyRevision) || policy.policyRevision < 1) {
    throw new Error("shop policy revision is invalid");
  }
  return { currency: data.shop.currencyCode, policy };
}

async function readProductPolicies(gql, ids) {
  const result = new Map();
  for (const batch of chunks(ids, 50)) {
    const data = await gql(`
      query PricingActivationPolicies($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            metafield(namespace: "${APP_NS}", key: "${POLICY_KEY}") {
              jsonValue
              compareDigest
            }
          }
        }
      }
    `, { ids: batch });
    for (const product of data.nodes || []) {
      if (product?.id) result.set(product.id, product.metafield || null);
    }
  }
  return result;
}

async function writePolicies(gql, rows) {
  for (const batch of chunks(rows, 25)) {
    const metafields = batch.map((row) => ({
      ownerId: row.productId,
      namespace: APP_NS,
      key: POLICY_KEY,
      type: "json",
      value: row.desired,
      compareDigest: row.compareDigest,
    }));
    const data = await gql(`
      mutation ActivatePricingPolicies($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { owner { ... on Product { id } } compareDigest }
          userErrors { field message code elementIndex }
        }
      }
    `, { metafields });
    const errors = data.metafieldsSet?.userErrors || [];
    if (errors.length) throw new Error(`metafieldsSet failed: ${JSON.stringify(errors)}`);
    if ((data.metafieldsSet?.metafields || []).length !== batch.length) {
      throw new Error("metafieldsSet returned an incomplete result");
    }
  }
}

const prisma = createScriptPrismaClient();
try {
  const store = await prisma.store.findUnique({ where: { shopDomain: SHOP }, select: { id: true } });
  if (!store) throw new Error("store not found");

  const overrides = await prisma.productPricingOverride.findMany({
    where: { storeId: store.id, isActive: true },
    select: {
      shopifyProductId: true,
      pricingProfile: { select: { id: true, revision: true, isActive: true, currency: true } },
    },
    orderBy: { shopifyProductId: "asc" },
  });
  if (overrides.length !== EXPECTED_COUNT) throw new Error(`expected ${EXPECTED_COUNT} active overrides, found ${overrides.length}`);
  if (overrides.some((row) => !row.pricingProfile?.isActive)) throw new Error("an override has no active pricing profile");

  const rows = overrides.map((row) => ({
    productId: row.shopifyProductId.startsWith("gid://") ? row.shopifyProductId : `gid://shopify/Product/${row.shopifyProductId}`,
    profile: row.pricingProfile,
  }));
  if (new Set(rows.map((row) => row.productId)).size !== EXPECTED_COUNT) throw new Error("duplicate product ids found");

  const { gql } = await connectAdmin();
  const shop = await readShopPolicy(gql);
  if (rows.some((row) => row.profile.currency !== shop.currency)) throw new Error("pricing-profile currency does not match shop currency");

  const live = await readProductPolicies(gql, rows.map((row) => row.productId));
  const planned = [];
  let alreadyActive = 0;
  for (const row of rows) {
    const metafield = live.get(row.productId);
    if (!metafield?.compareDigest) throw new Error(`missing policy metafield for ${row.productId}`);
    const current = parsePolicy(metafield.jsonValue);
    if (
      current.schema !== 1 || current.required !== true ||
      current.profileRef !== row.profile.id || current.profileRevision !== row.profile.revision
    ) {
      throw new Error(`policy/profile mismatch for ${row.productId}`);
    }
    const desired = canonicalPolicy({
      profileRef: row.profile.id,
      profileRevision: row.profile.revision,
      policyRevision: shop.policy.policyRevision,
    });
    if (JSON.stringify(current) === desired) alreadyActive += 1;
    else planned.push({ productId: row.productId, compareDigest: metafield.compareDigest, desired });
  }

  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    shopMode: shop.policy.mode,
    shopPolicyRevision: shop.policy.policyRevision,
    targetCount: rows.length,
    alreadyActive,
    activateCount: planned.length,
  }, null, 2));

  if (APPLY) {
    await writePolicies(gql, planned);
    const after = await readProductPolicies(gql, rows.map((row) => row.productId));
    let verified = 0;
    for (const row of rows) {
      const current = parsePolicy(after.get(row.productId)?.jsonValue);
      const expected = canonicalPolicy({
        profileRef: row.profile.id,
        profileRevision: row.profile.revision,
        policyRevision: shop.policy.policyRevision,
      });
      if (JSON.stringify(current) !== expected) throw new Error(`post-write verification failed for ${row.productId}`);
      verified += 1;
    }
    console.log(JSON.stringify({ applied: true, verifiedActivePolicies: verified }, null, 2));
  }
} finally {
  await prisma.$disconnect();
}
