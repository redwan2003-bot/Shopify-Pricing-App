import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createTestPrisma } from "../../../test/support/prisma.ts";
import { handleComplianceWebhook, normalizeComplianceTopic } from "./handle.ts";

const prisma = createTestPrisma();
const SHOP = `compliance-test-${process.pid}.myshopify.com`;
const OTHER = `compliance-test-other-${process.pid}.myshopify.com`;

after(async () => {
  await prisma.store.deleteMany({ where: { shopDomain: { in: [SHOP, OTHER] } } });
  await prisma.session.deleteMany({ where: { shop: { in: [SHOP, OTHER] } } });
  await prisma.$disconnect();
});

async function seed(shopDomain: string) {
  const store = await prisma.store.upsert({ where: { shopDomain }, update: {}, create: { shopDomain } });
  await prisma.inquiry.createMany({
    data: [
      { storeId: store.id, kind: "quote", name: "Ada", email: "ada@example.com", message: "one" },
      { storeId: store.id, kind: "info", name: "Ada", email: "ada@example.com", message: "two" },
      { storeId: store.id, kind: "info", name: "Bo", email: "bo@example.com", message: "three" },
    ],
  });
  return store;
}

test("topic names are recognised in both the webhook and the SDK spelling", () => {
  assert.equal(normalizeComplianceTopic("customers/data_request"), "customers/data_request");
  assert.equal(normalizeComplianceTopic("CUSTOMERS_DATA_REQUEST"), "customers/data_request");
  assert.equal(normalizeComplianceTopic("CUSTOMERS_REDACT"), "customers/redact");
  assert.equal(normalizeComplianceTopic("shop/redact"), "shop/redact");
  assert.equal(normalizeComplianceTopic("SHOP_REDACT"), "shop/redact");
  assert.equal(normalizeComplianceTopic("products/update"), null);
});

test("customers/data_request reports the customer's inquiries and deletes nothing", async () => {
  await seed(SHOP);
  const r = await handleComplianceWebhook(prisma, { shop: SHOP, topic: "CUSTOMERS_DATA_REQUEST", payload: { customer: { id: 1, email: "ADA@example.com" } } });
  assert.deepEqual(r, { handled: true, topic: "customers/data_request", inquiriesMatched: 2 });
  assert.equal(await prisma.inquiry.count({ where: { store: { shopDomain: SHOP } } }), 3);
});

test("customers/redact deletes only that customer's inquiries, only in that shop", async () => {
  await seed(OTHER);
  const r = await handleComplianceWebhook(prisma, { shop: SHOP, topic: "customers/redact", payload: { customer: { email: "ada@example.com" } } });
  assert.deepEqual(r, { handled: true, topic: "customers/redact", inquiriesDeleted: 2 });
  assert.equal(await prisma.inquiry.count({ where: { store: { shopDomain: SHOP } } }), 1, "Bo's inquiry stays");
  assert.equal(await prisma.inquiry.count({ where: { store: { shopDomain: OTHER } } }), 3, "another shop is untouched");
});

test("a customer or shop we hold nothing for is a complete, successful answer", async () => {
  const noStore = await handleComplianceWebhook(prisma, { shop: "nobody.myshopify.com", topic: "customers/redact", payload: { customer: { email: "x@example.com" } } });
  assert.deepEqual(noStore, { handled: true, topic: "customers/redact", inquiriesDeleted: 0 });
  const noEmail = await handleComplianceWebhook(prisma, { shop: SHOP, topic: "customers/data_request", payload: {} });
  assert.deepEqual(noEmail, { handled: true, topic: "customers/data_request", inquiriesMatched: 0 });
});

test("shop/redact removes the shop's data and sessions but not another shop's", async () => {
  await prisma.session.create({ data: { id: `offline_${SHOP}`, shop: SHOP, state: "x", isOnline: false, accessToken: "t" } });
  const r = await handleComplianceWebhook(prisma, { shop: SHOP, topic: "shop/redact", payload: { shop_domain: SHOP } });
  assert.deepEqual(r, { handled: true, topic: "shop/redact", shopDataDeleted: true });
  assert.equal(await prisma.store.count({ where: { shopDomain: SHOP } }), 0);
  assert.equal(await prisma.inquiry.count({ where: { store: { shopDomain: SHOP } } }), 0);
  assert.equal(await prisma.session.count({ where: { shop: SHOP } }), 0);
  assert.equal(await prisma.store.count({ where: { shopDomain: OTHER } }), 1);
});

test("a non-compliance topic is not handled here", async () => {
  const r = await handleComplianceWebhook(prisma, { shop: SHOP, topic: "products/update", payload: {} });
  assert.equal(r.handled, false);
});
