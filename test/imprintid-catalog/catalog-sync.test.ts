/**
 * Task 6A §3 / 6A.1 §2 §3 §10 — catalog synchronization.
 *
 * Driven end to end through the real state machine with a synthetic Admin transport and
 * synthetic JSONL: no real Shopify bulk operation, no real store. Proves exact
 * bulk-operation ownership, full-variant ingestion, bounded resumable steps, removal
 * detection, shop scoping, and the 6,500-product performance envelope.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { advanceCatalogSync, startCatalogSync, ACTIVE_SYNC_SENTINEL, computeBulkPollBackoffMs, describeIngestError } from "../../app/lib/catalog/catalog-sync.ts";
import { prisma, makeShopDomain, seedStore, cleanupShops, buildCatalogJsonl } from "./helpers.ts";
import { FakeAdmin, fakeResultFetcher } from "./fake-admin.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

async function newStore(currency = "USD") {
  const domain = makeShopDomain("catalog-sync");
  shops.push(domain);
  return { domain, storeId: await seedStore(domain, currency) };
}

const RESULT_URL = "https://storage.test/bulk-result.jsonl";

/** Runs start → poll → ingest to completion against a synthetic Shopify. */
async function runSyncToCompletion(
  storeId: string,
  jsonl: string,
  opts: { maxObjects?: number; key?: string } = {},
) {
  const admin = new FakeAdmin();
  const fetchResult = fakeResultFetcher({ [RESULT_URL]: jsonl });
  const started = await startCatalogSync(prisma, storeId, admin, opts.key ?? `k-${Math.random()}`);
  assert.ok(started.ok, JSON.stringify(started));
  const jobId = started.state.jobId;
  const opId = started.state.bulkOperationId!;

  // Shopify finishes building the export.
  admin.setOperationStatus(opId, { status: "COMPLETED", url: RESULT_URL, objectCount: jsonl.split("\n").filter(Boolean).length });

  let steps = 0;
  for (;;) {
    steps += 1;
    const res = await advanceCatalogSync(prisma, storeId, jobId, { admin, fetchResult, maxObjects: opts.maxObjects });
    assert.ok(res.ok, JSON.stringify(res));
    if (res.state.done) return { admin, jobId, steps, state: res.state };
    assert.ok(steps < 500, "sync did not converge");
  }
}

// ---------------------------------------------------------------------------
// Task 6A.4B.1 — a real sync got stuck reporting "CREATED" forever after 377 client
// steps, despite Shopify completing the bulk operation within 2 seconds. Root cause: the
// UI's continuation loop kept resubmitting `intent: "sync.start"` — whose IDEMPOTENT
// replay (same key) echoes the stale row and never polls Shopify again — instead of
// switching to `sync.advance`. These prove the backoff signal and the fix.
// ---------------------------------------------------------------------------

test("computeBulkPollBackoffMs: bounded, growing schedule", () => {
  assert.equal(computeBulkPollBackoffMs(0), 1_000);
  assert.equal(computeBulkPollBackoffMs(9_999), 1_000);
  assert.equal(computeBulkPollBackoffMs(10_000), 2_000);
  assert.equal(computeBulkPollBackoffMs(29_999), 2_000);
  assert.equal(computeBulkPollBackoffMs(30_000), 5_000);
  assert.equal(computeBulkPollBackoffMs(119_999), 5_000);
  assert.equal(computeBulkPollBackoffMs(120_000), 15_000);
  assert.equal(computeBulkPollBackoffMs(10 * 60_000), 15_000, "capped — never grows without bound");
});

test("CREATED/RUNNING carries a positive retryAfterMs; ingesting and terminal states carry null", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin();
  const started = await startCatalogSync(prisma, storeId, admin, `backoff-${Math.random()}`);
  assert.ok(started.ok);
  assert.equal(started.state.bulkOperationStatus, "CREATED");
  assert.ok(started.state.retryAfterMs && started.state.retryAfterMs > 0, "waiting on Shopify with nothing to ingest → must back off");

  const opId = started.state.bulkOperationId!;
  const jsonl = buildCatalogJsonl([{ id: "gid://shopify/Product/9001", title: "P" }]);

  // Still building — another poll while CREATED still backs off.
  const stillCreated = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: fakeResultFetcher({}) });
  assert.ok(stillCreated.ok);
  assert.ok((stillCreated.state.retryAfterMs ?? 0) > 0);

  // Shopify finishes → the job moves to `ingesting`, which has real bounded work waiting:
  // no artificial delay.
  admin.setOperationStatus(opId, { status: "COMPLETED", url: RESULT_URL, objectCount: 1 });
  const ingesting = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: fakeResultFetcher({ [RESULT_URL]: jsonl }), maxObjects: 0 });
  assert.ok(ingesting.ok);
  assert.equal(ingesting.state.status, "ingesting");
  assert.equal(ingesting.state.retryAfterMs, null, "real bounded work is waiting — call back-to-back");

  const done = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: fakeResultFetcher({ [RESULT_URL]: jsonl }) });
  assert.ok(done.ok && done.state.done);
  assert.equal(done.state.retryAfterMs, null, "a finished job never asks the caller to wait");
});

test("regression — resubmitting `sync.start` (the bug) is an idempotent no-op storm: it never polls Shopify again", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin();
  const key = "same-key-forever";

  const started = await startCatalogSync(prisma, storeId, admin, key);
  assert.ok(started.ok && started.created);
  const bulkRunCallsAfterStart = admin.calls.filter((c) => c.op === "bulkRun").length;
  assert.equal(bulkRunCallsAfterStart, 1);

  // Shopify finishes the export almost immediately — exactly what the live diagnosis found
  // (completed within 2 seconds of being created).
  admin.setOperationStatus(started.state.bulkOperationId!, { status: "COMPLETED", url: RESULT_URL, objectCount: 1 });

  // The buggy client behaviour: resubmit `sync.start` with the SAME key, over and over.
  for (let i = 0; i < 50; i++) {
    const replay = await startCatalogSync(prisma, storeId, admin, key);
    assert.ok(replay.ok);
    assert.equal(replay.created, false, "idempotent replay, not a new sync");
    assert.equal(replay.state.status, "awaiting_bulk", "stuck exactly as observed — never advances");
    assert.equal(replay.state.bulkOperationStatus, "CREATED", "echoes the STALE pre-completion snapshot, forever");
  }
  // Not one of those 50 replays made a real Shopify call — they are pure DB echoes.
  assert.equal(admin.calls.filter((c) => c.op === "bulkRun").length, bulkRunCallsAfterStart);
  assert.equal(admin.calls.filter((c) => c.op === "bulkById").length, 0, "sync.start's replay path never polls the bulk operation");

  const job = await prisma.catalogSyncJob.findUniqueOrThrow({ where: { id: started.state.jobId } });
  assert.equal(job.bulkOperationObjects, 0, "the DB was never touched again after the very first write");

  // The FIX: switching to `sync.advance` (what `continueIntent` now tells the client to
  // do) polls the exact owned operation and discovers it is already done.
  const advanced = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: fakeResultFetcher({ [RESULT_URL]: buildCatalogJsonl([{ id: "gid://shopify/Product/9002" }]) }) });
  assert.ok(advanced.ok, JSON.stringify(advanced));
  assert.notEqual(advanced.state.bulkOperationStatus, "CREATED", "one real `sync.advance` call unsticks it");
});

test("page-reload / resume — the loader reflects the exact stuck state with zero Shopify calls; `sync.advance` after reload finishes it", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin();
  const started = await startCatalogSync(prisma, storeId, admin, `reload-${Math.random()}`);
  assert.ok(started.ok);
  // Reproduces the exact live state found in production: Shopify already COMPLETED, but
  // this app's job row is still `awaiting_bulk` / CREATED because nothing has polled since
  // the very first write.
  admin.setOperationStatus(started.state.bulkOperationId!, { status: "COMPLETED", url: RESULT_URL, objectCount: 1 });
  const callsBeforeReload = admin.calls.length;

  const { loadCatalogAdmin } = await import("../../app/lib/catalog/catalog-admin.ts");
  const { resolveStoreContext } = await import("../../app/lib/catalog/tenancy.ts");
  const store = await resolveStoreContext(prisma, (await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).shopDomain);

  const reloaded = await loadCatalogAdmin(prisma, store!, new URLSearchParams());
  const view = reloaded.syncJobs.find((j) => j.id === started.state.jobId)!;
  assert.equal(view.status, "awaiting_bulk");
  assert.equal(view.bulkOperationStatus, "CREATED", "the reload shows the stuck state exactly as persisted — no auto-poll");
  assert.equal(view.active, true);
  assert.equal(reloaded.activeSyncJobId, started.state.jobId);
  assert.equal(admin.calls.length, callsBeforeReload, "loading the page performs ZERO Shopify calls");

  // The user clicks "Continue synchronization" — a real `sync.advance` — and it finishes.
  const jsonl = buildCatalogJsonl([{ id: "gid://shopify/Product/9003", title: "Resumed" }]);
  let step = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: fakeResultFetcher({ [RESULT_URL]: jsonl }) });
  let guard = 0;
  while (step.ok && !step.state.done && guard++ < 20) {
    step = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: fakeResultFetcher({ [RESULT_URL]: jsonl }) });
  }
  assert.ok(step.ok && step.state.done, JSON.stringify(step));
  assert.equal(step.state.status, "completed");
});

test("ingests products AND every variant through the nested bulk connection", async () => {
  const { storeId } = await newStore();
  const jsonl = buildCatalogJsonl([
    {
      id: "gid://shopify/Product/501", title: "Tee", vendor: "Acme", productType: "Apparel", tags: ["a", "B"],
      variants: [
        { id: "gid://shopify/ProductVariant/1", sku: "" },
        { id: "gid://shopify/ProductVariant/2", sku: "TEE-01" },
      ],
    },
    { id: "gid://shopify/Product/502", title: "Mug", variants: [{ id: "gid://shopify/ProductVariant/3", sku: "" }] },
  ]);
  const { state } = await runSyncToCompletion(storeId, jsonl);

  assert.equal(state.status, "completed");
  assert.equal(state.productsUpserted, 2);
  assert.equal(state.variantsUpserted, 3);

  const p1 = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: "gid://shopify/Product/501" } });
  assert.equal(p1.title, "Tee");
  assert.equal(p1.tags, "a,b", "tags lowercased + comma-joined");
  assert.equal(p1.hasAnySku, true);

  const variants = await prisma.catalogVariant.findMany({ where: { storeId, shopifyProductId: "gid://shopify/Product/501" }, orderBy: { position: "asc" } });
  assert.equal(variants.length, 2);
  assert.equal(variants[0]!.sku, null, "an empty Shopify SKU is stored as NULL, not \"\"");
  assert.equal(variants[1]!.sku, "TEE-01");
});

test("§3 — a product with more than 100 variants stores them all, including a SKU past position 100", async () => {
  const { storeId } = await newStore();
  const variants = Array.from({ length: 250 }, (_, i) => ({
    id: `gid://shopify/ProductVariant/${70000 + i}`,
    sku: i === 199 ? "DEEP-SKU-200" : `V-${i}`,
  }));
  const jsonl = buildCatalogJsonl([{ id: "gid://shopify/Product/9001", title: "Many Variants", variants }]);
  const { state } = await runSyncToCompletion(storeId, jsonl);

  assert.equal(state.variantsUpserted, 250, "all 250 variants ingested — no first:100 boundary");
  assert.equal(await prisma.catalogVariant.count({ where: { storeId, shopifyProductId: "gid://shopify/Product/9001" } }), 250);

  const deep = await prisma.catalogVariant.findFirstOrThrow({ where: { storeId, sku: "DEEP-SKU-200" } });
  assert.equal(deep.position, 199, "the matching SKU really is past position 100");
});

test("re-running the sync does not duplicate products or variants", async () => {
  const { storeId } = await newStore();
  const jsonl = buildCatalogJsonl([
    { id: "gid://shopify/Product/601", title: "One", variants: [{ id: "gid://shopify/ProductVariant/11", sku: "S1" }] },
  ]);
  await runSyncToCompletion(storeId, jsonl);
  const edited = buildCatalogJsonl([
    { id: "gid://shopify/Product/601", title: "One (edited)", variants: [{ id: "gid://shopify/ProductVariant/11", sku: "S1-NEW" }] },
  ]);
  await runSyncToCompletion(storeId, edited);

  assert.equal(await prisma.catalogProduct.count({ where: { storeId } }), 1);
  assert.equal(await prisma.catalogVariant.count({ where: { storeId } }), 1);
  const row = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId } });
  assert.equal(row.title, "One (edited)");
  const v = await prisma.catalogVariant.findFirstOrThrow({ where: { storeId } });
  assert.equal(v.sku, "S1-NEW");
});

test("detects products and variants removed from Shopify", async () => {
  const { storeId } = await newStore();
  await runSyncToCompletion(storeId, buildCatalogJsonl([
    { id: "gid://shopify/Product/701", title: "Keep", variants: [{ id: "gid://shopify/ProductVariant/21", sku: "K1" }, { id: "gid://shopify/ProductVariant/22", sku: "K2" }] },
    { id: "gid://shopify/Product/702", title: "Drop", variants: [{ id: "gid://shopify/ProductVariant/23", sku: "D1" }] },
  ]));

  const { state } = await runSyncToCompletion(storeId, buildCatalogJsonl([
    { id: "gid://shopify/Product/701", title: "Keep", variants: [{ id: "gid://shopify/ProductVariant/21", sku: "K1" }] },
  ]));

  assert.equal(state.productsRemoved, 1);
  assert.equal(state.variantsRemoved, 2, "the dropped product's variant AND the deleted sibling variant");
  const dropped = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: "gid://shopify/Product/702" } });
  assert.ok(dropped.removedFromShopifyAt);
  const keptVariant = await prisma.catalogVariant.findFirstOrThrow({ where: { storeId, shopifyVariantId: "gid://shopify/ProductVariant/21" } });
  assert.equal(keptVariant.removedFromShopifyAt, null);
});

test("§2 — polling uses the OWNED bulk operation id, never currentBulkOperation", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin();
  const jsonl = buildCatalogJsonl([{ id: "gid://shopify/Product/801", title: "Ours" }]);
  const fetchResult = fakeResultFetcher({ [RESULT_URL]: jsonl });

  const started = await startCatalogSync(prisma, storeId, admin, "owned");
  assert.ok(started.ok);
  const ourOp = started.state.bulkOperationId!;

  // A DIFFERENT operation becomes the app's "current" one — it must be ignored.
  admin.registerForeignOperation({ id: "gid://shopify/BulkOperation/999999", status: "COMPLETED", type: "QUERY", objectCount: 5, url: "https://storage.test/SOMEONE-ELSE.jsonl" });
  admin.options.currentOperation = { id: "gid://shopify/BulkOperation/999999", status: "COMPLETED" };

  admin.setOperationStatus(ourOp, { status: "COMPLETED", url: RESULT_URL, objectCount: 1 });
  const poll = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult });
  assert.ok(poll.ok);
  const ingest = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult });
  assert.ok(ingest.ok);
  assert.equal(ingest.state.status, "completed");
  assert.equal(ingest.state.bulkOperationId, ourOp, "the job ingested ITS OWN operation");

  // Only our product landed — the foreign operation's result url was never fetched.
  assert.equal(await prisma.catalogProduct.count({ where: { storeId } }), 1);
  assert.ok(!admin.calls.some((c) => c.op === "currentBulkOperation" && false), "sanity");
});

test("§2 — a bulk operation that no longer exists fails the job instead of ingesting anything", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin();
  const started = await startCatalogSync(prisma, storeId, admin, "missing-op");
  assert.ok(started.ok);
  admin.operations.delete(started.state.bulkOperationId!);

  const res = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: fakeResultFetcher({}) });
  assert.equal(res.ok, false);
  assert.equal(res.code, "BULK_OPERATION_NOT_FOUND");
  const job = await prisma.catalogSyncJob.findFirstOrThrow({ where: { id: started.state.jobId } });
  assert.equal(job.status, "failed");
  assert.equal(job.activeSentinel, null, "the active-sync slot is released on failure");
});

test("§2 — a node that is not a BulkOperation is rejected (id/type mismatch)", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin();
  const started = await startCatalogSync(prisma, storeId, admin, "wrong-type");
  assert.ok(started.ok);
  admin.setOperationStatus(started.state.bulkOperationId!, { type: "NOT_A_BULK_OP", status: "COMPLETED", url: RESULT_URL });

  const res = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: fakeResultFetcher({ [RESULT_URL]: "" }) });
  assert.equal(res.ok, false);
  assert.equal(res.code, "BULK_OPERATION_WRONG_TYPE");
});

test("§2 — a bulk operation already owned by another job is refused", async () => {
  const a = await newStore();
  const b = await newStore();
  const adminA = new FakeAdmin();
  const startedA = await startCatalogSync(prisma, a.storeId, adminA, "own-a");
  assert.ok(startedA.ok);
  const sharedOpId = startedA.state.bulkOperationId!;

  // Shop B's job is (impossibly) pointed at shop A's operation.
  const jobB = await prisma.catalogSyncJob.create({
    data: { storeId: b.storeId, idempotencyKey: "stolen", status: "awaiting_bulk", bulkOperationId: sharedOpId, activeSentinel: ACTIVE_SYNC_SENTINEL },
  });
  adminA.setOperationStatus(sharedOpId, { status: "COMPLETED", url: RESULT_URL, objectCount: 1 });

  const res = await advanceCatalogSync(prisma, b.storeId, jobB.id, { admin: adminA, fetchResult: fakeResultFetcher({ [RESULT_URL]: "" }) });
  assert.equal(res.ok, false);
  assert.equal(res.code, "BULK_OPERATION_ALREADY_OWNED");
  assert.equal(await prisma.catalogProduct.count({ where: { storeId: b.storeId } }), 0);
});

test("§2 — only one catalog synchronization can be active per shop", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin();
  const first = await startCatalogSync(prisma, storeId, admin, "first");
  assert.ok(first.ok);

  const second = await startCatalogSync(prisma, storeId, admin, "second");
  assert.equal(second.ok, false);
  assert.equal(second.code, "SYNC_ALREADY_ACTIVE");
  assert.equal(second.activeJobId, first.state.jobId);

  // After the first finishes, a new one may start.
  admin.setOperationStatus(first.state.bulkOperationId!, { status: "COMPLETED", url: RESULT_URL, objectCount: 0 });
  const fetchResult = fakeResultFetcher({ [RESULT_URL]: "" });
  for (let i = 0; i < 5; i++) {
    const r = await advanceCatalogSync(prisma, storeId, first.state.jobId, { admin, fetchResult });
    if (r.ok && r.state.done) break;
  }
  const third = await startCatalogSync(prisma, storeId, admin, "third");
  assert.equal(third.ok, true, JSON.stringify(third));
});

test("§2 — a foreign in-flight bulk operation blocks a new synchronization", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin({ currentOperation: { id: "gid://shopify/BulkOperation/555", status: "RUNNING" } });
  const res = await startCatalogSync(prisma, storeId, admin, "blocked");
  assert.equal(res.ok, false);
  assert.equal(res.code, "FOREIGN_BULK_OPERATION_IN_FLIGHT");
});

test("§1 — a bounded ingest checkpoints and resumes exactly where it stopped", async () => {
  const { storeId } = await newStore();
  const products = Array.from({ length: 12 }, (_, i) => ({
    id: `gid://shopify/Product/${8100 + i}`,
    title: `P${i}`,
    variants: [{ id: `gid://shopify/ProductVariant/${8200 + i}`, sku: `SK-${i}` }],
  }));
  // 2 lines per product → maxObjects 6 means ~3 products per request.
  const { steps, state } = await runSyncToCompletion(storeId, buildCatalogJsonl(products), { maxObjects: 6 });

  assert.ok(steps > 3, `expected several bounded requests, got ${steps}`);
  assert.equal(state.productsUpserted, 12, "no product lost or duplicated across the resume boundaries");
  assert.equal(await prisma.catalogProduct.count({ where: { storeId } }), 12);
  assert.equal(await prisma.catalogVariant.count({ where: { storeId } }), 12);
});

test("a partial bulk result completes the job as 'partial', never 'completed'", async () => {
  const { storeId } = await newStore();
  const admin = new FakeAdmin();
  const partialUrl = "https://storage.test/partial.jsonl";
  const jsonl = buildCatalogJsonl([{ id: "gid://shopify/Product/8500", title: "Half" }]);
  const fetchResult = fakeResultFetcher({ [partialUrl]: jsonl });

  const started = await startCatalogSync(prisma, storeId, admin, "partial");
  assert.ok(started.ok);
  admin.setOperationStatus(started.state.bulkOperationId!, { status: "FAILED", errorCode: "INTERNAL_SERVER_ERROR", partialDataUrl: partialUrl, objectCount: 1 });

  await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult });
  const res = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult });
  assert.ok(res.ok);
  assert.equal(res.state.status, "partial");
  assert.equal(res.state.productsUpserted, 1);
});

test("a sync only ever writes rows for its own store", async () => {
  const a = await newStore();
  const b = await newStore();
  await runSyncToCompletion(a.storeId, buildCatalogJsonl([{ id: "gid://shopify/Product/901", title: "A-only", variants: [{ id: "gid://shopify/ProductVariant/901", sku: "A" }] }]));
  await runSyncToCompletion(b.storeId, buildCatalogJsonl([{ id: "gid://shopify/Product/902", title: "B-only", variants: [{ id: "gid://shopify/ProductVariant/902", sku: "B" }] }]));

  assert.equal(await prisma.catalogProduct.count({ where: { storeId: a.storeId } }), 1);
  assert.equal(await prisma.catalogVariant.count({ where: { storeId: a.storeId } }), 1);
  assert.equal(await prisma.catalogProduct.count({ where: { storeId: a.storeId, shopifyProductId: "gid://shopify/Product/902" } }), 0);
});

// ---------------------------------------------------------------------------
// Set-based upsert semantics (one INSERT … ON CONFLICT … DO UPDATE per bounded batch).
// ---------------------------------------------------------------------------

test("upsert semantics: unchanged variants are only re-marked, changed ones are rewritten, products are refreshed", async () => {
  const { storeId } = await newStore();
  const P = "gid://shopify/Product/7101";
  const V1 = "gid://shopify/ProductVariant/7101";
  const V2 = "gid://shopify/ProductVariant/7102";

  const first = await runSyncToCompletion(
    storeId,
    buildCatalogJsonl([{ id: P, title: "Old title", handle: "old", vendor: "Acme", variants: [{ id: V1, sku: "S1" }, { id: V2, sku: "S2" }] }]),
  );
  const product0 = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: P } });
  assert.equal(product0.lastSeenSyncId, first.jobId);

  // State the sync does NOT own, plus a "removed" marker and a stale variant timestamp.
  const marker = new Date("2026-02-02T00:00:00Z");
  await prisma.catalogProduct.update({ where: { id: product0.id }, data: { policyDigest: "digest-keep", coverageStatus: "assigned", removedFromShopifyAt: marker } });
  await prisma.catalogVariant.updateMany({ where: { storeId }, data: { shopifyUpdatedAt: marker } });

  const second = await runSyncToCompletion(
    storeId,
    buildCatalogJsonl([{ id: P, title: "New title", handle: "new", vendor: "Globex", variants: [{ id: V1, sku: "S1" }, { id: V2, sku: "S2-changed" }] }]),
  );

  const product1 = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: P } });
  assert.equal(product1.id, product0.id, "the row id is preserved");
  assert.equal(product1.title, "New title");
  assert.equal(product1.handle, "new");
  assert.equal(product1.vendor, "Globex");
  assert.equal(product1.lastSeenSyncId, second.jobId);
  assert.equal(product1.removedFromShopifyAt, null, "a product seen again is revived");
  assert.equal(product1.firstSeenAt.getTime(), product0.firstSeenAt.getTime(), "firstSeenAt is never rewritten");
  assert.equal(product1.policyDigest, "digest-keep", "pricing-coverage columns are not touched by a sync");
  assert.equal(product1.coverageStatus, "assigned");

  const v1 = await prisma.catalogVariant.findFirstOrThrow({ where: { storeId, shopifyVariantId: V1 } });
  const v2 = await prisma.catalogVariant.findFirstOrThrow({ where: { storeId, shopifyVariantId: V2 } });
  assert.equal(v1.lastSeenSyncId, second.jobId, "an unchanged variant is still marked as seen");
  assert.equal(v1.shopifyUpdatedAt?.getTime(), marker.getTime(), "an unchanged variant's other columns are left alone");
  assert.equal(v2.sku, "S2-changed");
  assert.equal(v2.lastSeenSyncId, second.jobId);
  assert.equal(v2.shopifyUpdatedAt, null, "a changed variant is rewritten from the incoming row");
  assert.equal(await prisma.catalogVariant.count({ where: { storeId } }), 2, "no duplicates");
});

test("upsert semantics: a product with more variants than one statement carries is stored completely", async () => {
  const { storeId } = await newStore();
  const P = "gid://shopify/Product/7201";
  const variants = Array.from({ length: 1200 }, (_, i) => ({ id: `gid://shopify/ProductVariant/${720_000 + i}`, sku: i % 2 === 0 ? `SKU-${i}` : undefined }));
  const { state } = await runSyncToCompletion(storeId, buildCatalogJsonl([{ id: P, title: "Big", variants }]));

  assert.equal(state.status, "completed");
  assert.equal(await prisma.catalogVariant.count({ where: { storeId, shopifyProductId: P } }), 1200);
  assert.equal(await prisma.catalogVariant.count({ where: { storeId, sku: { not: null } } }), 600);
  const last = await prisma.catalogVariant.findFirstOrThrow({ where: { storeId, shopifyVariantId: "gid://shopify/ProductVariant/720999" } });
  assert.equal(last.position, 999, "positions survive the split into statements");
  const product = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: P } });
  assert.equal(product.hasAnySku, true);
});

test("upsert semantics: the same product twice in one batch keeps the later row; both occurrences' variants are stored", async () => {
  const { storeId } = await newStore();
  const P = "gid://shopify/Product/7301";
  await runSyncToCompletion(
    storeId,
    buildCatalogJsonl([
      { id: P, title: "First", variants: [{ id: "gid://shopify/ProductVariant/73011", sku: "A" }] },
      { id: P, title: "Second", variants: [{ id: "gid://shopify/ProductVariant/73012", sku: "B" }] },
    ]),
  );
  const rows = await prisma.catalogProduct.findMany({ where: { storeId } });
  assert.equal(rows.length, 1, "one product row");
  assert.equal(rows[0].title, "Second", "last occurrence wins");
  const variants = await prisma.catalogVariant.findMany({ where: { storeId }, orderBy: { sku: "asc" } });
  assert.deepEqual(variants.map((v) => v.sku), ["A", "B"], "variants of both occurrences are kept");
  assert.ok(variants.every((v) => v.catalogProductId === rows[0].id));
});

/** Runs a sync over `jsonl` until it fails; returns the failed (not ok) result. */
async function runSyncExpectingFailure(storeId: string, jsonl: string) {
  const admin = new FakeAdmin();
  const fetchResult = fakeResultFetcher({ [RESULT_URL]: jsonl });
  const started = await startCatalogSync(prisma, storeId, admin, `k-${Math.random()}`);
  assert.ok(started.ok);
  admin.setOperationStatus(started.state.bulkOperationId!, { status: "COMPLETED", url: RESULT_URL, objectCount: jsonl.split("\n").filter(Boolean).length });

  // The first step moves the job from polling to ingesting; the failure appears on a later one.
  let res = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult });
  for (let steps = 0; res.ok && !res.state.done && steps < 10; steps++) {
    res = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult });
  }
  if (res.ok) assert.fail(`expected a failure, got ${JSON.stringify(res.state)}`);
  return res;
}

test("INGEST_ERROR returns and records the underlying error", async () => {
  const { storeId } = await newStore();
  const res = await runSyncExpectingFailure(storeId, JSON.stringify({ id: "not-a-product-gid", title: "x" }) + "\n");
  assert.equal(res.code, "INGEST_ERROR");
  assert.match(res.message, /catalog line has no valid product id/, "the underlying message is returned");
  assert.match(res.state?.errorMessage ?? "", /catalog line has no valid product id/, "and recorded on the job");
});

test("a repeated variant id in one batch is rejected with a safe INGEST_ERROR and nothing is written", async () => {
  const { storeId } = await newStore();
  const V = "gid://shopify/ProductVariant/7401";
  const res = await runSyncExpectingFailure(
    storeId,
    buildCatalogJsonl([{ id: "gid://shopify/Product/7400", title: "Dup", variants: [{ id: V, sku: "A" }, { id: V, sku: "B" }] }]),
  );
  assert.equal(res.code, "INGEST_ERROR");
  assert.match(res.message, /duplicate variant id in one ingest batch/);
  assert.ok(res.message.includes(V), "names the offending Shopify id");
  assert.ok(!/postgres|npg_|password/i.test(res.message), "carries nothing but the id");
  assert.equal(res.state?.status, "partial", "the job is resumable, not completed");
  assert.equal(await prisma.catalogProduct.count({ where: { storeId } }), 0, "the check runs before any statement");
  assert.equal(await prisma.catalogVariant.count({ where: { storeId } }), 0);
});

test("describeIngestError removes connection strings and credential-looking values and bounds the length", () => {
  const nasty = new Error(
    "connect failed for postgresql://neondb_owner:npg_AbCdEf123456@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require\n  password=hunter2 and token: abc.def   npg_ZZZZ9999",
  );
  const out = describeIngestError(nasty);
  assert.ok(!out.includes("npg_"), out);
  assert.ok(!out.includes("neondb_owner"), out);
  assert.ok(!out.includes("hunter2"), out);
  assert.ok(!out.includes("abc.def"), out);
  assert.ok(!out.includes("\n"));
  assert.match(out, /<redacted-url>/);
  assert.equal(describeIngestError("x".repeat(5000)).length, 300);
  assert.equal(describeIngestError("plain failure"), "plain failure");
});

test("§10 — 6,500 products with variants ingest in bounded batches with bounded memory", async () => {
  const { storeId } = await newStore();
  const N = 6500;
  const admin = new FakeAdmin();

  // Build the JSONL lazily so the whole file never exists in memory at once, mirroring
  // production `fetch(url).body`.
  const enc = new TextEncoder();
  const lazyFetcher = async (): Promise<AsyncIterable<Uint8Array>> =>
    (async function* () {
      for (let i = 0; i < N; i++) {
        const pid = `gid://shopify/Product/${2_000_000 + i}`;
        yield enc.encode(
          JSON.stringify({ id: pid, title: `Perf ${i}`, handle: `perf-${i}`, status: "ACTIVE", tags: [], updatedAt: "2026-02-02T00:00:00Z", variantsCount: { count: 1 } }) + "\n" +
          JSON.stringify({ id: `gid://shopify/ProductVariant/${3_000_000 + i}`, sku: i % 2 ? `SKU-${i}` : "", __parentId: pid }) + "\n",
        );
      }
    })();

  const started = await startCatalogSync(prisma, storeId, admin, "perf");
  assert.ok(started.ok);
  admin.setOperationStatus(started.state.bulkOperationId!, { status: "COMPLETED", url: RESULT_URL, objectCount: N * 2 });

  // First advance = the bulk-operation poll (cheap); the second is the ingest we measure.
  const poll = await advanceCatalogSync(prisma, storeId, started.state.jobId, { admin, fetchResult: lazyFetcher });
  assert.ok(poll.ok);
  assert.equal(poll.state.status, "ingesting");

  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const res = await advanceCatalogSync(prisma, storeId, started.state.jobId, {
    admin,
    fetchResult: lazyFetcher,
    maxObjects: Number.MAX_SAFE_INTEGER, // one pass, to measure the ingest itself
  });
  const elapsedMs = performance.now() - t0;
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

  assert.ok(res.ok);
  assert.equal(res.state.status, "completed");
  assert.equal(res.state.productsUpserted, N);
  assert.equal(res.state.variantsUpserted, N);
  assert.equal(await prisma.catalogProduct.count({ where: { storeId } }), N);
  assert.equal(await prisma.catalogVariant.count({ where: { storeId, sku: { not: null } } }), N / 2);

  assert.ok(heapDeltaMb < 120, `heap delta ${heapDeltaMb.toFixed(1)}MB stays well under a full-catalog buffer`);
  // eslint-disable-next-line no-console
  console.log(`[perf] ${N} products + ${N} variants: ${elapsedMs.toFixed(0)}ms (${(elapsedMs / N).toFixed(1)}ms/product), heap +${heapDeltaMb.toFixed(1)}MB`);
  assert.ok(elapsedMs < 180_000, `ingest took ${elapsedMs.toFixed(0)}ms (budget 180000ms)`);
});
