/**
 * Task 6A §3, §11 — product webhook handlers.
 *
 * HMAC verification is exercised against the REAL `@shopify/shopify-app-react-router`
 * `authenticate.webhook` (a bad signature → 401). The dedupe + shop-scoping +
 * catalog-application logic is exercised directly with synthetic payloads.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { shopifyApp, ApiVersion, AppDistribution } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import {
  handleProductWebhookEvent,
  recordWebhookOnce,
  applyProductUpsertWebhook,
  applyProductDeleteWebhook,
} from "../../app/lib/catalog/webhook-sync.ts";
import { prisma, makeShopDomain, seedStore, cleanupShops, seedCatalogProduct } from "./helpers.ts";

const SECRET = "webhook-test-secret";
const shopify = shopifyApp({
  apiKey: "test-key",
  apiSecretKey: SECRET,
  apiVersion: ApiVersion.July26,
  appUrl: "https://example.com",
  distribution: AppDistribution.AppStore,
  sessionStorage: new PrismaSessionStorage(prisma),
});

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

function webhookRequest(topic: string, shop: string, webhookId: string, payload: unknown, opts: { badHmac?: boolean } = {}): Request {
  const body = JSON.stringify(payload);
  const hmac = opts.badHmac ? "not-a-valid-hmac" : createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
  return new Request("https://example.com/webhooks/products/x", {
    method: "POST",
    headers: {
      "X-Shopify-Topic": topic,
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Webhook-Id": webhookId,
      "Content-Type": "application/json",
    },
    body,
  });
}

test("a webhook with an invalid HMAC is rejected (401) before any handler runs", async () => {
  const req = webhookRequest("products/create", "demo.myshopify.com", "wh-bad", { id: 1 }, { badHmac: true });
  await assert.rejects(
    () => shopify.authenticate.webhook(req),
    (err: unknown) => err instanceof Response && err.status === 401,
  );
});

test("a webhook with a valid HMAC authenticates and exposes shop / topic / webhookId", async () => {
  const req = webhookRequest("products/create", "demo.myshopify.com", "wh-ok", { id: 5, admin_graphql_api_id: "gid://shopify/Product/5" });
  const ctx = await shopify.authenticate.webhook(req);
  assert.equal(ctx.shop, "demo.myshopify.com");
  assert.equal(ctx.topic, "PRODUCTS_CREATE");
  assert.equal(ctx.webhookId, "wh-ok");
});

test("products/create upserts the store's catalog row (pricing-admin fields only)", async () => {
  const domain = makeShopDomain("catalog-wh");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");

  const out = await handleProductWebhookEvent(prisma, {
    shop: domain,
    topic: "PRODUCTS_CREATE",
    webhookId: "c-1",
    payload: {
      admin_graphql_api_id: "gid://shopify/Product/777",
      title: "Webhook Tee",
      handle: "webhook-tee",
      status: "active",
      vendor: "WH Vendor",
      product_type: "Apparel",
      tags: "New, Sale",
      updated_at: "2026-03-01T00:00:00Z",
      variants: [
        { id: 71, admin_graphql_api_id: "gid://shopify/ProductVariant/71", title: "S", sku: "WH-1" },
        { id: 72, admin_graphql_api_id: "gid://shopify/ProductVariant/72", title: "M", sku: "" },
      ],
    },
  });
  assert.equal(out.status, "processed");

  const row = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: "gid://shopify/Product/777" } });
  assert.equal(row.title, "Webhook Tee");
  assert.equal(row.status, "ACTIVE");
  assert.equal(row.vendor, "WH Vendor");
  assert.equal(row.tags, "new,sale");
  assert.equal(row.hasAnySku, true);
  assert.equal(row.variantCount, 2);

  // Task 6A.1 — the child variant catalog is kept in step, so exact SKU search stays
  // correct between full syncs.
  const variants = await prisma.catalogVariant.findMany({ where: { storeId, shopifyProductId: "gid://shopify/Product/777" }, orderBy: { position: "asc" } });
  assert.equal(variants.length, 2);
  assert.equal(variants[0]!.sku, "WH-1");
  assert.equal(variants[1]!.sku, null, "an empty Shopify SKU is stored as NULL");
});

test("§3 — a products/update that removes a variant soft-removes it from the SKU catalog", async () => {
  const domain = makeShopDomain("catalog-wh");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const GID = "gid://shopify/Product/7770";

  const withTwo = {
    admin_graphql_api_id: GID,
    title: "Two variants",
    variants: [
      { admin_graphql_api_id: "gid://shopify/ProductVariant/8801", sku: "KEEP-1" },
      { admin_graphql_api_id: "gid://shopify/ProductVariant/8802", sku: "GONE-1" },
    ],
  };
  await handleProductWebhookEvent(prisma, { shop: domain, topic: "PRODUCTS_CREATE", webhookId: "v-1", payload: withTwo });
  assert.equal(await prisma.catalogVariant.count({ where: { storeId, removedFromShopifyAt: null } }), 2);

  await handleProductWebhookEvent(prisma, {
    shop: domain,
    topic: "PRODUCTS_UPDATE",
    webhookId: "v-2",
    payload: { ...withTwo, variants: [withTwo.variants[0]!] },
  });

  const live = await prisma.catalogVariant.findMany({ where: { storeId, removedFromShopifyAt: null } });
  assert.equal(live.length, 1);
  assert.equal(live[0]!.sku, "KEEP-1");
  const gone = await prisma.catalogVariant.findFirstOrThrow({ where: { storeId, shopifyVariantId: "gid://shopify/ProductVariant/8802" } });
  assert.ok(gone.removedFromShopifyAt, "the removed variant is soft-removed, not deleted");
});

test("§3 — products/delete soft-removes the product's variants too", async () => {
  const domain = makeShopDomain("catalog-wh");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const GID = "gid://shopify/Product/7771";

  await handleProductWebhookEvent(prisma, {
    shop: domain, topic: "PRODUCTS_CREATE", webhookId: "d-1",
    payload: { admin_graphql_api_id: GID, title: "Doomed", variants: [{ admin_graphql_api_id: "gid://shopify/ProductVariant/8811", sku: "BYE" }] },
  });
  await handleProductWebhookEvent(prisma, { shop: domain, topic: "PRODUCTS_DELETE", webhookId: "d-2", payload: { admin_graphql_api_id: GID } });

  assert.equal(await prisma.catalogVariant.count({ where: { storeId, removedFromShopifyAt: null } }), 0);
  const v = await prisma.catalogVariant.findFirstOrThrow({ where: { storeId, shopifyVariantId: "gid://shopify/ProductVariant/8811" } });
  assert.ok(v.removedFromShopifyAt);
});

test("a duplicate webhook delivery (same X-Shopify-Webhook-Id) is idempotent", async () => {
  const domain = makeShopDomain("catalog-wh");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");

  const payload = { admin_graphql_api_id: "gid://shopify/Product/888", title: "First", variants: [] };
  const first = await handleProductWebhookEvent(prisma, { shop: domain, topic: "PRODUCTS_CREATE", webhookId: "dup-1", payload });
  assert.equal(first.status, "processed");

  // same webhook id, different (later) payload — must NOT be applied
  const second = await handleProductWebhookEvent(prisma, {
    shop: domain, topic: "PRODUCTS_UPDATE", webhookId: "dup-1", payload: { ...payload, title: "Changed" },
  });
  assert.equal(second.status, "duplicate");

  const row = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: "gid://shopify/Product/888" } });
  assert.equal(row.title, "First", "the duplicate delivery did not overwrite");
  assert.equal(await prisma.webhookEvent.count({ where: { storeId, webhookId: "dup-1" } }), 1);
});

test("products/update and products/delete only ever touch the delivering shop's catalog", async () => {
  const a = makeShopDomain("catalog-wh");
  const b = makeShopDomain("catalog-wh");
  shops.push(a, b);
  const aStore = await seedStore(a, "USD");
  const bStore = await seedStore(b, "USD");

  // Both shops happen to have a product with the same Shopify GID.
  const GID = "gid://shopify/Product/999000";
  await seedCatalogProduct(aStore, { gid: GID, title: "A original" });
  await seedCatalogProduct(bStore, { gid: GID, title: "B original" });

  await handleProductWebhookEvent(prisma, { shop: a, topic: "PRODUCTS_UPDATE", webhookId: "u-a", payload: { admin_graphql_api_id: GID, title: "A updated", variants: [] } });
  await handleProductWebhookEvent(prisma, { shop: b, topic: "PRODUCTS_DELETE", webhookId: "d-b", payload: { admin_graphql_api_id: GID } });

  const aRow = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId: aStore, shopifyProductId: GID } });
  const bRow = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId: bStore, shopifyProductId: GID } });
  assert.equal(aRow.title, "A updated");
  assert.equal(aRow.removedFromShopifyAt, null, "shop A's product was not deleted by shop B's webhook");
  assert.equal(bRow.title, "B original");
  assert.ok(bRow.removedFromShopifyAt, "shop B's product was soft-removed");
});

test("a webhook for a shop with no Store row is ignored, not an error", async () => {
  const out = await handleProductWebhookEvent(prisma, { shop: "never-installed.myshopify.com", topic: "PRODUCTS_CREATE", webhookId: "x-1", payload: { id: 1 } });
  assert.equal(out.status, "ignored");
});

test("recordWebhookOnce dedupes per (store, webhookId)", async () => {
  const domain = makeShopDomain("catalog-wh");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  assert.equal((await recordWebhookOnce(prisma, storeId, "r-1", "products/create", domain)).duplicate, false);
  assert.equal((await recordWebhookOnce(prisma, storeId, "r-1", "products/create", domain)).duplicate, true);
});

test("a malformed product id in a webhook payload is ignored without throwing", async () => {
  const domain = makeShopDomain("catalog-wh");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const up = await applyProductUpsertWebhook(prisma, storeId, { id: "not-an-id", title: "x" });
  assert.equal(up.applied, false);
  const del = await applyProductDeleteWebhook(prisma, storeId, { admin_graphql_api_id: "gid://shopify/Order/1" });
  assert.equal(del.applied, false);
});
