/**
 * Task 6A.1 §1 §8 §9 — the operational Admin workflow, exercised through the ACTUAL
 * action dispatcher (`handleCatalogAdminAction`) and loader (`loadCatalogAdmin`) that
 * `app/routes/app.catalog/route.tsx` calls, with a synthetic Admin transport.
 *
 * The route module itself is a thin wrapper: it calls `authenticate.admin(request)`
 * (framework-enforced — proven by the webhook HMAC test and every other route), resolves
 * the store from `session.shop`, and forwards to the dispatcher below. Everything with
 * behaviour lives here.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { handleCatalogAdminAction, loadCatalogAdmin } from "../../app/lib/catalog/catalog-admin.ts";
import { resolveStoreContext } from "../../app/lib/catalog/tenancy.ts";
import {
  prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedManyCatalogProducts,
  ENFORCEMENT_DISABLED, ENFORCEMENT_ENABLED,
  overrideKeyFor
} from "./helpers.ts";
import { FakeAdmin, fakeResultFetcher } from "./fake-admin.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

const RESULT_URL = "https://storage.test/route-result.jsonl";

function ctx(store: Awaited<ReturnType<typeof resolveStoreContext>>, admin: FakeAdmin, resultBody = "") {
  return {
    prisma,
    store: store!,
    admin,
    actor: { userId: "gid://shopify/StaffMember/42" },
    shopPolicy: { ok: true as const, shopCurrency: "USD", enforcementPolicyJson: admin.options.enforcementPolicy ?? null },
    fetchResult: fakeResultFetcher({ [RESULT_URL]: resultBody }),
  };
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function scenario(opts: { products?: number } = {}) {
  const domain = makeShopDomain("catalog-route");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const store = await resolveStoreContext(prisma, domain);
  const profile = await seedProfile(storeId, { name: "Route", currency: "USD" });
  const gids: string[] = [];
  for (let i = 0; i < (opts.products ?? 3); i++) gids.push((await seedCatalogProduct(storeId)).shopifyProductId);
  return { domain, storeId, store, profile, gids };
}

test("§9 — full workflow: sync.start → sync.advance* → dryRun → apply → job.process* → completed", async () => {
  const domain = makeShopDomain("catalog-route");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const store = await resolveStoreContext(prisma, domain);
  const profile = await seedProfile(storeId, { name: "Route", currency: "USD" });

  const jsonl = [
    { id: "gid://shopify/Product/40001", title: "One", variants: [{ id: "gid://shopify/ProductVariant/50001", sku: "R-1" }] },
    { id: "gid://shopify/Product/40002", title: "Two", variants: [{ id: "gid://shopify/ProductVariant/50002", sku: "R-2" }] },
  ]
    .map((p) => JSON.stringify({ id: p.id, title: p.title, handle: "h", status: "ACTIVE", tags: [], updatedAt: "2026-01-01T00:00:00Z", variantsCount: { count: p.variants.length } }) + "\n" +
      p.variants.map((v) => JSON.stringify({ id: v.id, sku: v.sku, __parentId: p.id })).join("\n"))
    .join("\n") + "\n";

  const admin = new FakeAdmin({ shopCurrency: "USD", enforcementPolicy: ENFORCEMENT_DISABLED });
  const c = ctx(store, admin, jsonl);

  // --- sync.start: creates the job AND starts the bulk op. Never "complete".
  const start = await handleCatalogAdminAction(c, form({ intent: "sync.start", idempotencyKey: "route-sync" }));
  assert.ok(start.ok);
  assert.equal(start.more, true, "sync.start must not report completion — the export is still building");
  assert.match(start.message, /started/i);
  const syncJobId = (start.data as { syncJobId: string }).syncJobId;

  // Shopify finishes building.
  admin.setOperationStatus(admin.lastOperationId!, { status: "COMPLETED", url: RESULT_URL, objectCount: 4 });

  // --- sync.advance until done.
  let step = await handleCatalogAdminAction(c, form({ intent: "sync.advance", syncJobId }));
  let guard = 0;
  while (step.ok && step.more && guard++ < 20) {
    step = await handleCatalogAdminAction(c, form({ intent: "sync.advance", syncJobId }));
  }
  assert.ok(step.ok && !step.more, JSON.stringify(step));
  assert.equal(await prisma.catalogProduct.count({ where: { storeId } }), 2);
  assert.equal(await prisma.catalogVariant.count({ where: { storeId } }), 2);

  // --- dryRun over everything.
  const dry = await handleCatalogAdminAction(c, form({
    intent: "dryRun", selection: JSON.stringify({ kind: "all" }), acknowledgeWholeCatalog: "1", pricingProfileId: profile.id, idempotencyKey: "route-dry",
  }));
  assert.ok(dry.ok, JSON.stringify(dry));
  assert.equal(dry.more, false);
  const { jobId, dryRunFingerprint } = dry.data as { jobId: string; dryRunFingerprint: string };
  assert.equal((dry.data as { counts: { eligible: number } }).counts.eligible, 2);

  // --- apply: materializes; does NOT write to Shopify. Not "complete".
  const apply = await handleCatalogAdminAction(c, form({ intent: "apply", jobId, dryRunFingerprint }));
  assert.ok(apply.ok, JSON.stringify(apply));
  assert.equal(apply.more, true, "apply only creates the job — processing has not started");
  assert.match(apply.message, /has not started/i);

  // --- job.process until completed.
  let proc = await handleCatalogAdminAction(c, form({ intent: "job.process", jobId }));
  guard = 0;
  while (proc.ok && proc.more && guard++ < 50) {
    proc = await handleCatalogAdminAction(c, form({ intent: "job.process", jobId }));
  }
  assert.ok(proc.ok && !proc.more, JSON.stringify(proc));
  assert.match(proc.message, /complete/i);

  const job = await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: jobId } });
  assert.equal(job.status, "completed");
  assert.equal(job.succeeded, 2);
  for (const gid of ["gid://shopify/Product/40001", "gid://shopify/Product/40002"]) {
    assert.equal(await prisma.productPricingOverride.count({ where: { storeId, shopifyProductId: overrideKeyFor(gid) } }), 1);
    assert.ok(admin.metafields.has(gid), "the app-owned metafield was actually written via the real write port");
  }
});

test("§9 — a job survives a 'browser refresh': loadCatalogAdmin shows resumable state, processing continues", async () => {
  const { domain, storeId, store, profile } = await scenario({ products: 250 });
  const admin = new FakeAdmin({ shopCurrency: "USD", enforcementPolicy: ENFORCEMENT_DISABLED });
  const c = ctx(store, admin);

  const dry = await handleCatalogAdminAction(c, form({ intent: "dryRun", selection: JSON.stringify({ kind: "all" }), acknowledgeWholeCatalog: "1", pricingProfileId: profile.id, idempotencyKey: "refresh" }));
  assert.ok(dry.ok);
  const { jobId, dryRunFingerprint } = dry.data as { jobId: string; dryRunFingerprint: string };
  await handleCatalogAdminAction(c, form({ intent: "apply", jobId, dryRunFingerprint }));

  // Process ONE bounded request, then "close the browser".
  const first = await handleCatalogAdminAction(c, form({ intent: "job.process", jobId }));
  assert.ok(first.ok && first.more, "the job is not finished in one request");

  // Reload the page — the durable job state is visible and marked active.
  const reloaded = await loadCatalogAdmin(prisma, store!, new URLSearchParams());
  const view = reloaded.bulkJobs.find((j) => j.id === jobId)!;
  assert.ok(view.active, "the job shows as active after a reload");
  assert.ok(view.succeeded > 0 && view.succeeded < 250, "partial progress is persisted");
  assert.equal(reloaded.activeBulkJobId, jobId, "conflicting actions are disabled while this is set");

  // A fresh request finishes it from exactly where it stopped.
  let proc = await handleCatalogAdminAction(c, form({ intent: "job.process", jobId }));
  let guard = 0;
  while (proc.ok && proc.more && guard++ < 50) proc = await handleCatalogAdminAction(c, form({ intent: "job.process", jobId }));
  assert.equal((await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: jobId } })).succeeded, 250);
  void domain; void storeId;
});

test("Task 6A.4B.1 — sync.start and sync.advance name `continueIntent` and a backoff so the client never loops sync.start", async () => {
  const domain = makeShopDomain("catalog-route");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const store = await resolveStoreContext(prisma, domain);
  const admin = new FakeAdmin({ shopCurrency: "USD", enforcementPolicy: ENFORCEMENT_DISABLED });
  const c = ctx(store, admin, "");

  const start = await handleCatalogAdminAction(c, form({ intent: "sync.start", idempotencyKey: "backoff-route" }));
  assert.ok(start.ok);
  const startData = start.data as { continueIntent?: string; retryAfterMs?: number | null };
  assert.equal(startData.continueIntent, "sync.advance", "the client must switch intent, not keep resubmitting sync.start");
  assert.ok(startData.retryAfterMs && startData.retryAfterMs > 0, "still CREATED — the client must back off");

  const syncJobId = (start.data as { syncJobId: string }).syncJobId;
  const advance = await handleCatalogAdminAction(c, form({ intent: "sync.advance", syncJobId }));
  assert.ok(advance.ok);
  assert.equal((advance.data as { continueIntent?: string }).continueIntent, "sync.advance");
  void storeId;
});

test("6A.4D.1 — a whole-catalog dry run is refused without an explicit acknowledgement; a filtered one is not", async () => {
  const { store, profile, storeId } = await scenario({ products: 4 });
  await seedCatalogProduct(storeId, { vendor: "Acme" });
  const admin = new FakeAdmin({ shopCurrency: "USD", enforcementPolicy: ENFORCEMENT_DISABLED });
  const c = ctx(store, admin);

  // `kind: "all"` with no acknowledgement → refused.
  const blockedAll = await handleCatalogAdminAction(c, form({
    intent: "dryRun", selection: JSON.stringify({ kind: "all" }), pricingProfileId: profile.id, idempotencyKey: "wc-1",
  }));
  assert.equal(blockedAll.ok, false);
  assert.equal(blockedAll.code, "WHOLE_CATALOG_NOT_ACKNOWLEDGED");

  // An empty filter is just as much "the whole catalog" → also refused.
  const blockedEmpty = await handleCatalogAdminAction(c, form({
    intent: "dryRun", selection: JSON.stringify({ kind: "filter", filter: {} }), pricingProfileId: profile.id, idempotencyKey: "wc-2",
  }));
  assert.equal(blockedEmpty.ok, false);
  assert.equal(blockedEmpty.code, "WHOLE_CATALOG_NOT_ACKNOWLEDGED");

  // Same selection, WITH the acknowledgement → proceeds, and the response flags it.
  const ackd = await handleCatalogAdminAction(c, form({
    intent: "dryRun", selection: JSON.stringify({ kind: "all" }), acknowledgeWholeCatalog: "1",
    pricingProfileId: profile.id, replaceExisting: "1", idempotencyKey: "wc-3",
  }));
  assert.ok(ackd.ok, JSON.stringify(ackd));
  assert.equal((ackd.data as { wholeCatalog: boolean }).wholeCatalog, true);
  assert.equal((ackd.data as { replaceExisting: boolean }).replaceExisting, true);

  // A narrowing filter needs no acknowledgement.
  const filtered = await handleCatalogAdminAction(c, form({
    intent: "dryRun", selection: JSON.stringify({ kind: "filter", filter: { vendor: "Acme" } }),
    pricingProfileId: profile.id, idempotencyKey: "wc-4",
  }));
  assert.ok(filtered.ok, JSON.stringify(filtered));
  assert.equal((filtered.data as { wholeCatalog: boolean }).wholeCatalog, false);
  assert.equal((filtered.data as { counts: { totalMatched: number } }).counts.totalMatched, 1);
});

test("§9 — a job id belonging to another shop is rejected by every processing action", async () => {
  const a = await scenario();
  const b = await scenario();
  const admin = new FakeAdmin({ enforcementPolicy: ENFORCEMENT_DISABLED });

  // Build a real job in shop A.
  const ca = ctx(a.store, admin);
  const dry = await handleCatalogAdminAction(ca, form({ intent: "dryRun", selection: JSON.stringify({ kind: "all" }), acknowledgeWholeCatalog: "1", pricingProfileId: a.profile.id, idempotencyKey: "x" }));
  assert.ok(dry.ok);
  const { jobId, dryRunFingerprint } = dry.data as { jobId: string; dryRunFingerprint: string };
  await handleCatalogAdminAction(ca, form({ intent: "apply", jobId, dryRunFingerprint }));

  // Shop B presents shop A's job id.
  const cb = ctx(b.store, admin);
  for (const intent of ["job.process", "job.retry", "job.resume", "rollback.plan", "rollback.process"]) {
    const r = await handleCatalogAdminAction(cb, form({ intent, jobId }));
    assert.equal(r.ok, false, `${intent} must reject shop A's job for shop B`);
  }
  // ...and shop A's own dry-run job is untouched.
  assert.equal((await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: jobId } })).storeId, a.storeId);
});

test("§9 — exact SKU filtering returns the parent product, incl. a SKU past variant position 100", async () => {
  const { store, storeId } = await scenario({ products: 0 });
  const product = await seedCatalogProduct(storeId, { title: "Big" });
  const variantData = Array.from({ length: 180 }, (_, i) => ({
    storeId,
    catalogProductId: product.id,
    shopifyVariantId: `gid://shopify/ProductVariant/${900000 + i}`,
    shopifyProductId: product.shopifyProductId,
    title: `V${i}`,
    sku: i === 150 ? "FIND-ME-150" : `bulk-${i}`,
    position: i,
  }));
  for (let i = 0; i < variantData.length; i += 500) await prisma.catalogVariant.createMany({ data: variantData.slice(i, i + 500) });
  await seedCatalogProduct(storeId, { title: "Unrelated" });

  const exact = await loadCatalogAdmin(prisma, store!, new URLSearchParams({ sku: "FIND-ME-150" }));
  assert.equal(exact.page.items.length, 1);
  assert.equal(exact.page.items[0]!.shopifyProductId, product.shopifyProductId);

  const noMatch = await loadCatalogAdmin(prisma, store!, new URLSearchParams({ sku: "FIND-ME" }));
  assert.equal(noMatch.page.items.length, 0, "exact match by default — a prefix does not match");

  const contains = await loadCatalogAdmin(prisma, store!, new URLSearchParams({ sku: "FIND-ME", skuMatch: "contains" }));
  assert.equal(contains.page.items.length, 1);
});

test("§9 — a dry run is invalidated by a pricing-profile CHILD change (not just the top-level revision)", async () => {
  const { domain, store, storeId, profile } = await scenario({ products: 2 });
  const admin = new FakeAdmin({ shopCurrency: "USD", enforcementPolicy: ENFORCEMENT_DISABLED });
  const c = ctx(store, admin);

  const dry = await handleCatalogAdminAction(c, form({ intent: "dryRun", selection: JSON.stringify({ kind: "all" }), acknowledgeWholeCatalog: "1", pricingProfileId: profile.id, idempotencyKey: "child" }));
  assert.ok(dry.ok);
  const { jobId, dryRunFingerprint } = dry.data as { jobId: string; dryRunFingerprint: string };

  // Change a child row and run the centralized hook — revision + digest both move.
  const { syncPricingProfileRevision } = await import("../../app/lib/pricing/revision.ts");
  await prisma.quantityTier.create({ data: { pricingProfileId: profile.id, minQuantity: 10, maxQuantity: 20, listPriceCents: 100, netPriceCents: 90 } });
  await syncPricingProfileRevision(prisma, profile.id);

  const apply = await handleCatalogAdminAction(c, form({ intent: "apply", jobId, dryRunFingerprint }));
  assert.equal(apply.ok, false);
  assert.equal(apply.code, "PROFILE_REVISION_CHANGED");
  void domain; void storeId;
});

test("§9 — enforcement enabled between batches pauses the job and the UI reports it", async () => {
  const { store, storeId, profile } = await scenario({ products: 250 });
  const disabled = new FakeAdmin({ shopCurrency: "USD", enforcementPolicy: ENFORCEMENT_DISABLED });
  const cDisabled = ctx(store, disabled);

  const dry = await handleCatalogAdminAction(cDisabled, form({ intent: "dryRun", selection: JSON.stringify({ kind: "all" }), acknowledgeWholeCatalog: "1", pricingProfileId: profile.id, idempotencyKey: "enf" }));
  assert.ok(dry.ok);
  const { jobId, dryRunFingerprint } = dry.data as { jobId: string; dryRunFingerprint: string };
  await handleCatalogAdminAction(cDisabled, form({ intent: "apply", jobId, dryRunFingerprint }));
  await handleCatalogAdminAction(cDisabled, form({ intent: "job.process", jobId }));

  // Enforcement gets switched on before the next request.
  const enabled = new FakeAdmin({ shopCurrency: "USD", enforcementPolicy: ENFORCEMENT_ENABLED });
  const paused = await handleCatalogAdminAction(ctx(store, enabled), form({ intent: "job.process", jobId }));
  assert.equal(paused.ok, false);
  assert.equal(paused.code, "ENFORCEMENT_ENABLED");

  const view = await loadCatalogAdmin(prisma, store!, new URLSearchParams());
  assert.equal(view.bulkJobs.find((j) => j.id === jobId)!.status, "paused");
  void storeId;
});

test("§10 — a 6,500-product dry run's action payload carries counts + a digest, never 6,500 ids", async () => {
  const domain = makeShopDomain("catalog-route");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const store = await resolveStoreContext(prisma, domain);
  const profile = await seedProfile(storeId, { name: "Big", currency: "USD" });
  await seedManyCatalogProducts(storeId, 6500);

  const admin = new FakeAdmin({ shopCurrency: "USD", enforcementPolicy: ENFORCEMENT_DISABLED });
  const c = ctx(store, admin);
  const t0 = performance.now();
  const dry = await handleCatalogAdminAction(c, form({ intent: "dryRun", selection: JSON.stringify({ kind: "all" }), acknowledgeWholeCatalog: "1", pricingProfileId: profile.id, idempotencyKey: "big-route" }));
  const planMs = performance.now() - t0;
  assert.ok(dry.ok);

  const payloadBytes = Buffer.byteLength(JSON.stringify(dry));
  assert.ok(payloadBytes < 2500, `dry-run action payload is ${payloadBytes} bytes — counts + digest, not a 6,500-id list`);
  assert.equal((dry.data as { counts: { totalMatched: number } }).counts.totalMatched, 6500);
  // eslint-disable-next-line no-console
  console.log(`[perf] route dryRun over 6,500 products: ${planMs.toFixed(0)}ms, ${payloadBytes}-byte browser payload`);
});
