/**
 * Links every imported PricingProfile (one per catalog SKU, from
 * scripts/import-catalog-pricing.ts) to its real Shopify product on DEV_STORE, by
 * matching the profile's `sku` against the prefix of each product's variant SKUs
 * (the catalog's convention is `{SKU}_{Color}`, e.g. LDSPK_Multicolor).
 *
 * This is deliberately NOT routed through the Task 6A bulk-assignment system
 * (app/lib/catalog/apply.ts): that system assigns ONE profile to MANY products in a
 * single job. Here every product needs its OWN distinct profile — a 1:1 SKU-matched
 * pairing — so this writes the identical `$app:imprintid/pricing_policy` metafield
 * shape directly (via the same buildProductPolicyValue/canonicalPolicyJson helpers
 * the real system uses) plus a local ProductPricingOverride row for bookkeeping
 * parity with what that system would have recorded.
 *
 * Never enables enforcement — shop `enforcement_policy.enabled` is untouched.
 *
 * Usage: node scripts/shopify/link-catalog-pricing.mjs [--dry-run]
 */
import { PrismaClient } from "@prisma/client";
import { connectAdmin } from "./runtime.mjs";
import { DEV_STORE, POLICY_REVISION } from "./constants.mjs";
import { buildProductPolicyValue, canonicalPolicyJson } from "../../app/lib/catalog/policy-value.ts";
import { overrideProductKey } from "../../app/lib/catalog/gid.ts";

const METAFIELD_BATCH_SIZE = 25;

async function fetchAllProductSkuIndex(gql) {
  const index = new Map(); // skuPrefix (upper) -> Set of product GIDs
  const productTitles = new Map(); // product GID -> title
  let cursor = null;
  let pageCount = 0;
  for (;;) {
    const res = await gql(
      `query($cursor: String) {
        products(first: 100, after: $cursor) {
          edges {
            cursor
            node {
              id
              title
              variants(first: 100) { edges { node { sku } } }
            }
          }
          pageInfo { hasNextPage }
        }
      }`,
      { cursor },
    );
    const edges = res.products.edges;
    pageCount += 1;
    for (const { node } of edges) {
      productTitles.set(node.id, node.title);
      for (const vEdge of node.variants.edges) {
        const sku = vEdge.node.sku;
        if (!sku) continue;
        const prefix = sku.split("_")[0].toUpperCase();
        if (!index.has(prefix)) index.set(prefix, new Set());
        index.get(prefix).add(node.id);
      }
    }
    if (!res.products.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }
  console.log(`  scanned ${pageCount} page(s) of products, ${index.size} distinct SKU prefixes found`);
  return { index, productTitles };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const prisma = new PrismaClient();
  const { gql } = await connectAdmin();

  console.log(`Target shop: ${DEV_STORE}${dryRun ? " (DRY RUN)" : ""}`);
  console.log("Fetching full product/variant SKU index from Shopify...");
  const { index, productTitles } = await fetchAllProductSkuIndex(gql);

  const store = await prisma.store.findUnique({ where: { shopDomain: DEV_STORE } });
  if (!store) throw new Error(`no local Store row for ${DEV_STORE}`);

  const profiles = await prisma.pricingProfile.findMany({
    where: { storeId: store.id },
    select: { id: true, sku: true, name: true, revision: true, isActive: true },
  });
  console.log(`Found ${profiles.length} local pricing profiles to link.\n`);

  const matched = [];
  const heldBack = [];
  for (const profile of profiles) {
    const skuKey = (profile.sku || "").toUpperCase();
    const candidates = index.get(skuKey);
    if (!candidates || candidates.size === 0) {
      heldBack.push({ sku: profile.sku, reason: "no Shopify product found with a matching variant SKU prefix" });
      continue;
    }
    if (candidates.size > 1) {
      heldBack.push({ sku: profile.sku, reason: `ambiguous — ${candidates.size} products share this SKU prefix` });
      continue;
    }
    const productGid = [...candidates][0];
    matched.push({ profile, productGid, title: productTitles.get(productGid) });
  }

  console.log(`Matched: ${matched.length}`);
  console.log(`Held back: ${heldBack.length}\n`);

  if (dryRun) {
    for (const m of matched) console.log(`  would link ${m.profile.sku} -> ${m.title} (${m.productGid})`);
  } else {
    let written = 0;
    for (let i = 0; i < matched.length; i += METAFIELD_BATCH_SIZE) {
      const batch = matched.slice(i, i + METAFIELD_BATCH_SIZE);
      const metafields = batch.map((m) => {
        const value = buildProductPolicyValue({
          profileId: m.profile.id,
          profileRevision: m.profile.revision,
          policyRevision: POLICY_REVISION,
        });
        return {
          ownerId: m.productGid,
          namespace: "$app:imprintid",
          key: "pricing_policy",
          type: "json",
          value: canonicalPolicyJson(value),
        };
      });

      const res = await gql(
        `mutation($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message code }
          }
        }`,
        { metafields },
      );
      const errs = res.metafieldsSet.userErrors;
      if (errs.length) {
        console.error(`  batch ${i / METAFIELD_BATCH_SIZE + 1}: ${JSON.stringify(errs)}`);
      }
      written += res.metafieldsSet.metafields.length;
      console.log(`  batch ${i / METAFIELD_BATCH_SIZE + 1}/${Math.ceil(matched.length / METAFIELD_BATCH_SIZE)}: wrote ${res.metafieldsSet.metafields.length}/${batch.length} policy metafields`);

      // Local bookkeeping parity with the Task 6A bulk-assignment system.
      for (const m of batch) {
        const key = overrideProductKey(m.productGid) ?? m.productGid;
        await prisma.productPricingOverride.upsert({
          where: { storeId_shopifyProductId: { storeId: store.id, shopifyProductId: key } },
          update: { pricingProfileId: m.profile.id, isActive: true },
          create: { storeId: store.id, shopifyProductId: key, pricingProfileId: m.profile.id, isActive: true },
        });
      }
    }
    console.log(`\nWrote pricing_policy for ${written} of ${matched.length} matched products.`);
  }

  console.log(`\n--- Held back (${heldBack.length}) ---`);
  for (const h of heldBack) console.log(`  ${h.sku}: ${h.reason}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
