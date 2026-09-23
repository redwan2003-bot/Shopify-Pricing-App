import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { createInquiry, INQUIRY_LIMITS } from "./create.ts";

const prisma = new PrismaClient({ datasources: { db: { url: "file:dev.sqlite?socket_timeout=45&connection_limit=1" } } });
const SHOP = `inquiry-test-${process.pid}.myshopify.com`;
const OTHER_SHOP = `inquiry-test-other-${process.pid}.myshopify.com`;

after(async () => {
  await prisma.store.deleteMany({ where: { shopDomain: { in: [SHOP, OTHER_SHOP] } } });
  await prisma.$disconnect();
});

const valid = { kind: "quote", name: "Ada Buyer", email: "Ada@Example.com", message: "Need 500 in red", quantity: 500 };

test("stores a valid quote request, lower-casing the email and scoping it to the shop", async () => {
  const result = await createInquiry(prisma, SHOP, {
    ...valid,
    shopifyProductId: "8438071820427",
    shopifyVariantId: "44010010000",
    sku: "LNY01_White",
    configuration: { quantity: 500, options: [] },
  });
  assert.equal(result.ok, true);
  const row = await prisma.inquiry.findFirstOrThrow({ where: { store: { shopDomain: SHOP } } });
  assert.equal(row.email, "ada@example.com");
  assert.equal(row.kind, "quote");
  assert.equal(row.status, "new");
  assert.equal(row.quantity, 500);
  assert.equal(row.sku, "LNY01_White");
  assert.deepEqual(JSON.parse(row.configuration!), { quantity: 500, options: [] });
});

test("a quote may have an empty note, but an info request needs a message", async () => {
  assert.equal((await createInquiry(prisma, SHOP, { kind: "quote", name: "B", email: "b@example.com" })).ok, true);
  const info = await createInquiry(prisma, SHOP, { kind: "info", name: "B", email: "b2@example.com", message: "  " });
  assert.equal(info.ok, false);
  assert.equal(info.ok === false && info.code, "INVALID_MESSAGE");
});

test("rejects bad names, emails, quantities, ids, kinds and oversized text", async () => {
  const code = async (patch: Record<string, unknown>) => {
    const r = await createInquiry(prisma, SHOP, { ...valid, email: `x${Math.random()}@example.com`, ...patch });
    return r.ok ? "ok" : r.code;
  };
  assert.equal(await code({ name: "" }), "INVALID_NAME");
  assert.equal(await code({ name: "n".repeat(INQUIRY_LIMITS.name + 1) }), "INVALID_NAME");
  assert.equal(await code({ email: "not-an-email" }), "INVALID_EMAIL");
  assert.equal(await code({ quantity: 0 }), "INVALID_QUANTITY");
  assert.equal(await code({ quantity: 1.5 }), "INVALID_QUANTITY");
  assert.equal(await code({ message: "m".repeat(INQUIRY_LIMITS.message + 1) }), "INVALID_MESSAGE");
  assert.equal(await code({ shopifyProductId: "gid://shopify/Product/1" }), "INVALID_INQUIRY");
  assert.equal(await code({ kind: "spam" }), "INVALID_INQUIRY");
  assert.equal((await createInquiry(prisma, SHOP, "nope")).ok, false);
  assert.equal((await createInquiry(prisma, SHOP, [])).ok, false);
});

test("the honeypot field silently succeeds without storing anything", async () => {
  const before = await prisma.inquiry.count({ where: { store: { shopDomain: OTHER_SHOP } } });
  const r = await createInquiry(prisma, OTHER_SHOP, { ...valid, website: "http://spam.example" });
  assert.deepEqual(r, { ok: true, id: "ignored" });
  assert.equal(await prisma.inquiry.count({ where: { store: { shopDomain: OTHER_SHOP } } }), before);
});

test("throttles a single email per shop, but not other emails or shops", async () => {
  const now = new Date();
  for (let i = 0; i < INQUIRY_LIMITS.throttleCount; i++) {
    assert.equal((await createInquiry(prisma, OTHER_SHOP, { ...valid, email: "spammy@example.com" }, now)).ok, true);
  }
  const blocked = await createInquiry(prisma, OTHER_SHOP, { ...valid, email: "spammy@example.com" }, now);
  assert.equal(blocked.ok === false && blocked.status, 429);
  assert.equal((await createInquiry(prisma, OTHER_SHOP, { ...valid, email: "someone.else@example.com" }, now)).ok, true);
  assert.equal((await createInquiry(prisma, SHOP, { ...valid, email: "spammy@example.com" }, now)).ok, true, "another shop is unaffected");
  const later = new Date(now.getTime() + INQUIRY_LIMITS.throttleWindowMs + 1000);
  assert.equal((await createInquiry(prisma, OTHER_SHOP, { ...valid, email: "spammy@example.com" }, later)).ok, true, "allowed again after the window");
});

test("an oversized configuration snapshot is dropped, not fatal", async () => {
  const r = await createInquiry(prisma, SHOP, { ...valid, email: "big@example.com", configuration: { blob: "x".repeat(INQUIRY_LIMITS.configuration) } });
  assert.equal(r.ok, true);
  const row = await prisma.inquiry.findFirstOrThrow({ where: { email: "big@example.com", store: { shopDomain: SHOP } } });
  assert.equal(row.configuration, null);
});
