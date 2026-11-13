import { connectAdmin, createScriptPrismaClient } from "./runtime.mjs";

const COLLECTION_ID = "gid://shopify/Collection/321851654283";
const ONLINE_STORE_PUBLICATION_ID = "gid://shopify/Publication/201433743499";
const APPLY = process.argv.includes("--apply");

const chunks = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

function assertNoErrors(label, payload) {
  const errors = payload?.userErrors || [];
  if (errors.length) throw new Error(`${label}: ${JSON.stringify(errors)}`);
}

async function currentCollectionProducts(gql) {
  const data = await gql(`
    query PricingCollection($id: ID!) {
      collection(id: $id) {
        id
        title
        products(first: 250) { nodes { id } pageInfo { hasNextPage } }
      }
    }
  `, { id: COLLECTION_ID });
  if (!data.collection) throw new Error("pricing collection not found");
  if (data.collection.products.pageInfo.hasNextPage) {
    throw new Error("collection exceeds the bounded 250-product maintenance limit");
  }
  return {
    title: data.collection.title,
    productIds: data.collection.products.nodes.map((node) => node.id),
  };
}

async function publicationState(gql, productIds) {
  const state = new Map();
  for (const batch of chunks(productIds, 50)) {
    const data = await gql(`
      query ProductPublications($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            status
            resourcePublicationsV2(first: 20) {
              nodes { isPublished publication { id } }
            }
          }
        }
      }
    `, { ids: batch });
    for (const product of data.nodes || []) {
      if (!product?.id) continue;
      const online = (product.resourcePublicationsV2?.nodes || []).some(
        (entry) => entry.isPublished && entry.publication?.id === ONLINE_STORE_PUBLICATION_ID,
      );
      state.set(product.id, { status: product.status, online });
    }
  }
  return state;
}

async function publishProducts(gql, productIds) {
  for (const batch of chunks(productIds, 20)) {
    const definitions = ["$publicationId: ID!", ...batch.map((_, i) => `$id${i}: ID!`)].join(", ");
    const fields = batch.map((_, i) => `
      p${i}: publishablePublish(
        id: $id${i}
        input: [{ publicationId: $publicationId }]
      ) { userErrors { field message } }
    `).join("\n");
    const variables = { publicationId: ONLINE_STORE_PUBLICATION_ID };
    batch.forEach((id, i) => { variables[`id${i}`] = id; });
    const data = await gql(`mutation PublishPricingProducts(${definitions}) { ${fields} }`, variables);
    batch.forEach((id, i) => assertNoErrors(`publish ${id}`, data[`p${i}`]));
  }
}

async function addProducts(gql, productIds) {
  for (const batch of chunks(productIds, 200)) {
    const data = await gql(`
      mutation AddPricingProducts($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) {
          userErrors { field message }
        }
      }
    `, { id: COLLECTION_ID, productIds: batch });
    assertNoErrors("collectionAddProducts", data.collectionAddProducts);
  }
}

async function removeProducts(gql, productIds) {
  if (!productIds.length) return;
  const data = await gql(`
    mutation RemoveNonPricingProducts($id: ID!, $productIds: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $productIds) {
        job { id done }
        userErrors { field message }
      }
    }
  `, { id: COLLECTION_ID, productIds });
  assertNoErrors("collectionRemoveProducts", data.collectionRemoveProducts);
}

const prisma = createScriptPrismaClient();
try {
  const store = await prisma.store.findUnique({
    where: { shopDomain: "imprintid-pricing-dev.myshopify.com" },
    select: { id: true },
  });
  if (!store) throw new Error("store not found");

  const overrides = await prisma.productPricingOverride.findMany({
    where: { storeId: store.id, isActive: true },
    select: { shopifyProductId: true },
    orderBy: { shopifyProductId: "asc" },
  });
  const targetIds = [...new Set(overrides.map(({ shopifyProductId }) =>
    shopifyProductId.startsWith("gid://")
      ? shopifyProductId
      : `gid://shopify/Product/${shopifyProductId}`,
  ))];

  const { gql } = await connectAdmin();
  const collection = await currentCollectionProducts(gql);
  const current = new Set(collection.productIds);
  const target = new Set(targetIds);
  const toAdd = targetIds.filter((id) => !current.has(id));
  const toRemove = collection.productIds.filter((id) => !target.has(id));
  const state = await publicationState(gql, targetIds);
  const missing = targetIds.filter((id) => !state.has(id));
  const nonActive = targetIds.filter((id) => state.get(id)?.status !== "ACTIVE");
  const toPublish = targetIds.filter((id) => !state.get(id)?.online);

  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    collection: collection.title,
    targetCount: targetIds.length,
    currentCount: collection.productIds.length,
    addCount: toAdd.length,
    removeCount: toRemove.length,
    publishCount: toPublish.length,
    missingCount: missing.length,
    nonActiveCount: nonActive.length,
  }, null, 2));

  if (missing.length || nonActive.length) {
    throw new Error(`refusing: missing=${missing.length}, non-active=${nonActive.length}`);
  }
  if (!APPLY) process.exitCode = 0;
  else {
    await publishProducts(gql, toPublish);
    await addProducts(gql, toAdd);
    await removeProducts(gql, toRemove);
    const after = await currentCollectionProducts(gql);
    console.log(JSON.stringify({ applied: true, immediateCollectionCount: after.productIds.length }, null, 2));
  }
} finally {
  await prisma.$disconnect();
}
