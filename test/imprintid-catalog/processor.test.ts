/**
 * Task 6A §7 / 6A.1 §6 §7 §10 — the durable, leased, compare-and-set processor.
 *
 * Driven by a synthetic `FakeWritePort` that enforces Shopify's compare-and-set
 * semantics — no real metafield is ever written. Proves: batched two-system writes;
 * idempotent rerun; CAS conflicts are never overwritten; partial failure recorded;
 * retry eligibility; expiring leases and stale-lease recovery; two requests never
 * process the same item; enforcement enabled between batches pauses the job.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { planBulkAssignment } from "../../app/lib/catalog/dry-run.ts";
import { confirmAndCreateJob } from "../../app/lib/catalog/apply.ts";
import { processAssignmentJob, requeueFailedItems, resumeInterruptedJob } from "../../app/lib/catalog/processor.ts";
import { acquireAssignmentLease, LEASE_TTL_MS } from "../../app/lib/catalog/leases.ts";
import {
  prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedManyCatalogProducts, seedOverride,
  FakeWritePort, ENFORCEMENT_DISABLED, ENFORCEMENT_ENABLED,
  overrideKeyFor
} from "./helpers.ts";
import { canonicalPolicyJson, buildProductPolicyValue } from "../../app/lib/catalog/policy-value.ts";

const isRemoteDatabase = Boolean(process.env.TEST_DATABASE_URL);
const runRemotePerfTests = process.env.RUN_REMOTE_PERF_TESTS === "1";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

async function queuedJob(productCount: number) {
  const domain = makeShopDomain("catalog-proc");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const profile = await seedProfile(storeId, { name: "Bulk", currency: "USD" });
  const products: string[] =
    productCount > 30
      ? await seedManyCatalogProducts(storeId, productCount)
      : await Promise.all(Array.from({ length: productCount }, async () => (await seedCatalogProduct(storeId)).shopifyProductId));

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: profile.id, replaceExisting: false, idempotencyKey: `dry-${Math.random()}`,
  });
  assert.ok(dry.ok, JSON.stringify(dry));
  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok, JSON.stringify(applied));
  return { domain, storeId, profileId: profile.id, jobId: dry.jobId, products };
}

/** Drives a job to a terminal state through bounded invocations, like the route does. */
async function runToCompletion(storeId: string, jobId: string, port: FakeWritePort, opts: { maxBatches?: number } = {}) {
  let invocations = 0;
  let result = await processAssignmentJob(prisma, storeId, jobId, {
    port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED, maxBatches: opts.maxBatches,
  });
  while (result.more && invocations < 500) {
    invocations += 1;
    result = await processAssignmentJob(prisma, storeId, jobId, {
      port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED, maxBatches: opts.maxBatches,
    });
  }
  return { result, invocations };
}

test("writes the local override AND the Shopify metafield, one batched round-trip each", async () => {
  const { storeId, jobId, profileId, products } = await queuedJob(3);
  const port = new FakeWritePort();
  const { result } = await runToCompletion(storeId, jobId, port);

  assert.equal(result.status, "completed");
  assert.equal(result.succeeded, 3);
  assert.equal(port.calls.filter((c) => c.op === "read").length, 1, "one batched policy read for the batch");
  assert.equal(port.calls.filter((c) => c.op === "set").length, 1, "one batched metafieldsSet for the batch");

  for (const gid of products) {
    const ov = await prisma.productPricingOverride.findFirstOrThrow({ where: { storeId, shopifyProductId: overrideKeyFor(gid) } });
    assert.equal(ov.pricingProfileId, profileId);
    assert.notEqual(port.current(gid), "", "metafield written");
    const cat = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: gid } });
    assert.ok(cat.policySyncedAt);
    assert.equal(cat.policyDigest, port.currentDigest(gid), "the digest of what we wrote is cached");
    assert.equal(cat.enforcementReady, true);
  }

  const item = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[0]! } });
  assert.equal(item.prevPolicyPresent, false, "the metafield was absent before the write");
  assert.equal(item.postPolicyDigest, port.currentDigest(products[0]!), "post-write digest retained for rollback CAS");
});

test("§6 — a compare-and-set conflict is never overwritten and never auto-retried", async () => {
  const { storeId, jobId, products } = await queuedJob(3);
  const port = new FakeWritePort();
  // Someone else already wrote a policy for products[1] — the processor will read it,
  // present ITS digest, and then a third party changes it again before the write lands.
  port.seedExisting(products[1]!, JSON.stringify({ schema: 1, required: true, active: true, profileRef: "other", profileRevision: 4, policyRevision: 4 }));
  port.failSet.set(products[1]!, [
    { ok: false, conflict: true, code: "CONFLICT_DIGEST_MISMATCH", message: "changed since read" },
  ]);
  const before = port.current(products[1]!);

  const { result } = await runToCompletion(storeId, jobId, port);
  assert.equal(result.status, "partial");
  assert.equal(result.conflicts, 1);
  assert.equal(result.succeeded, 2);
  assert.equal(port.current(products[1]!), before, "the concurrent value was preserved");

  const conflicted = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[1]! } });
  assert.equal(conflicted.status, "failed");
  assert.equal(conflicted.errorCode, "PERMANENT_POLICY_CONFLICT");

  // A conflict is NOT auto-retryable.
  const { requeued, permanent } = await requeueFailedItems(prisma, storeId, jobId);
  assert.equal(requeued, 0);
  assert.equal(permanent, 1);
});

test("§6 — the write presents the digest it just read (replace) or asserts absence (create)", async () => {
  const { storeId, jobId, products } = await queuedJob(2);
  const port = new FakeWritePort();
  // products[0] has an existing policy; products[1] has none.
  port.seedExisting(products[0]!, JSON.stringify({ schema: 1, required: true, active: true, profileRef: "prior", profileRevision: 2, policyRevision: 2 }));

  const { result } = await runToCompletion(storeId, jobId, port);
  assert.equal(result.status, "completed");

  const withPrior = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[0]! } });
  assert.equal(withPrior.prevPolicyPresent, true);
  assert.ok(withPrior.prevPolicyDigest, "the pre-write digest was captured");
  assert.notEqual(withPrior.prevPolicyDigest, withPrior.postPolicyDigest, "the write produced a new digest");

  const fresh = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[1]! } });
  assert.equal(fresh.prevPolicyPresent, false);
  assert.equal(fresh.prevPolicyDigest, null, "no digest to compare against — absence was asserted instead");
});

test("re-running a completed job performs zero further writes", async () => {
  const { storeId, jobId, products } = await queuedJob(2);
  const port = new FakeWritePort();
  await runToCompletion(storeId, jobId, port);
  const setCalls = port.calls.filter((c) => c.op === "set").length;

  const rerun = await processAssignmentJob(prisma, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  assert.equal(rerun.status, "completed");
  assert.equal(rerun.more, false);
  assert.equal(port.calls.filter((c) => c.op === "set").length, setCalls, "no further metafield writes");
  assert.equal(await prisma.bulkAssignmentItem.count({ where: { jobId } }), products.length);
});

test("Task 6A.3B §1 — a stale-coverage verification item settles as `unchanged` with ZERO writes and reconciles coverage", async () => {
  const domain = makeShopDomain("catalog-proc");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const profile = await seedProfile(storeId, { name: "Target", currency: "USD" });

  // LNY01-style: an active bare-ID override already on the target, CatalogProduct still
  // "unassigned", policy never synced locally.
  const prod = await seedCatalogProduct(storeId, { title: "LNY01", coverageStatus: "unassigned", policySyncedAt: null });
  await seedOverride(storeId, prod.shopifyProductId, profile.id);
  const overrideBefore = await prisma.productPricingOverride.findFirstOrThrow({
    where: { storeId, shopifyProductId: overrideKeyFor(prod.shopifyProductId) },
  });

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: [prod.shopifyProductId] }, pricingProfileId: profile.id, replaceExisting: false, idempotencyKey: `v-${Math.random()}`,
  });
  assert.ok(dry.ok);
  assert.equal(dry.counts.verificationRequired, 1);
  assert.equal(dry.counts.estimatedOperations, 0);

  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok, JSON.stringify(applied));

  // Shopify ALREADY holds exactly the desired policy (e.g. the provisioner wrote it).
  const port = new FakeWritePort();
  port.seedExisting(
    prod.shopifyProductId,
    canonicalPolicyJson(buildProductPolicyValue({ profileId: profile.id, profileRevision: 1, policyRevision: 1 })),
  );

  const { result } = await runToCompletion(storeId, dry.jobId, port);
  assert.equal(result.status, "completed");
  assert.equal(result.unchanged, 1, "the item is unchanged, not succeeded-via-assumed-write");
  assert.equal(result.succeeded, 0);
  assert.equal(port.calls.filter((c) => c.op === "set").length, 0, "ZERO metafieldsSet");
  assert.equal(port.calls.filter((c) => c.op === "delete").length, 0, "ZERO metafieldsDelete");

  const item = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId: dry.jobId } });
  assert.equal(item.status, "unchanged");
  assert.equal(item.overrideWritten, false);
  assert.equal(item.policyWritten, false);

  // The pre-existing override is byte-identical — not upserted.
  const overrideAfter = await prisma.productPricingOverride.findFirstOrThrow({
    where: { storeId, shopifyProductId: overrideKeyFor(prod.shopifyProductId) },
  });
  assert.equal(overrideAfter.updatedAt.getTime(), overrideBefore.updatedAt.getTime(), "override.updatedAt unchanged");
  assert.equal(overrideAfter.pricingProfileId, overrideBefore.pricingProfileId);

  // Coverage is reconciled off the stale "unassigned" state.
  const cat = await prisma.catalogProduct.findFirstOrThrow({ where: { storeId, shopifyProductId: prod.shopifyProductId } });
  assert.equal(cat.coverageStatus, "assigned");
  assert.equal(cat.assignedProfileId, profile.id);
  assert.ok(cat.policySyncedAt, "policy is now recorded as synced");
  assert.equal(cat.enforcementReady, true, "policy/override ready (enforcement itself still gated by the shop flag)");
});

test("a permanent Shopify failure is recorded as failed, the job is 'partial', and the local override is NOT written", async () => {
  const { storeId, jobId, products } = await queuedJob(3);
  const port = new FakeWritePort();
  port.failSet.set(products[1]!, [{ ok: false, retryable: false, code: "PERMANENT_POLICY_USERERROR", message: "bad value" }]);

  const { result } = await runToCompletion(storeId, jobId, port);
  assert.equal(result.status, "partial");
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);

  const failedItem = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[1]! } });
  assert.equal(failedItem.status, "failed");
  assert.equal(failedItem.errorCode, "PERMANENT_POLICY_USERERROR");
  // Task 6A.1.1 — Shopify-first: the metafield write failed, so the local override was
  // NEVER written. The product is fail-closed (native pricing), not stuck "dynamically
  // priced" with an unconfirmed policy.
  assert.equal(failedItem.overrideWritten, false);
  assert.equal(await prisma.productPricingOverride.count({ where: { storeId, shopifyProductId: overrideKeyFor(products[1]!) } }), 0);
});

test("a transient failure retries with backoff; manual retry re-queues only eligible items", async () => {
  const { storeId, jobId, products } = await queuedJob(2);
  const port = new FakeWritePort();
  port.failSet.set(products[0]!, Array.from({ length: 6 }, () => ({ ok: false as const, retryable: true, code: "TRANSIENT_THROTTLED", message: "429" })));
  port.failSet.set(products[1]!, [{ ok: false, retryable: false, code: "PERMANENT_POLICY_USERERROR", message: "no" }]);

  for (let i = 0; i < 8; i++) {
    await prisma.bulkAssignmentItem.updateMany({ where: { jobId, nextAttemptAt: { not: null } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await processAssignmentJob(prisma, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  }

  const exhausted = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[0]! } });
  const permanentItem = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[1]! } });
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.errorCode, "RETRY_EXHAUSTED");
  assert.equal(exhausted.attemptCount, 5, "the retry limit is persisted on the row, so it survives a restart");
  assert.equal(permanentItem.errorCode, "PERMANENT_POLICY_USERERROR");

  const { requeued, permanent } = await requeueFailedItems(prisma, storeId, jobId);
  assert.equal(requeued, 1, "only the RETRY_EXHAUSTED item is eligible");
  assert.equal(permanent, 1);

  port.failSet.set(products[0]!, []);
  await runToCompletion(storeId, jobId, port);
  const recovered = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[0]! } });
  assert.equal(recovered.status, "succeeded");
});

test("§7 — an expired job lease is recoverable; a live one is not stolen", async () => {
  const { storeId, jobId } = await queuedJob(3);

  // A live lease held by someone else blocks a second request.
  const held = await acquireAssignmentLease(prisma, storeId, jobId, "worker-A", new Date());
  assert.equal(held.acquired, true);
  const blocked = await processAssignmentJob(prisma, storeId, jobId, {
    port: new FakeWritePort(), shopEnforcementPolicyJson: ENFORCEMENT_DISABLED, workerId: "worker-B",
  });
  assert.equal(blocked.refused?.reason, "busy");
  assert.equal(blocked.succeeded, 0, "worker B wrote nothing");

  // resumeInterruptedJob refuses to steal a live lease...
  const refused = await resumeInterruptedJob(prisma, storeId, jobId);
  assert.equal(refused.resumed, false);

  // ...but once the lease expires the job is recoverable and completes.
  await prisma.bulkAssignmentJob.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(Date.now() - LEASE_TTL_MS) } });
  const resumed = await resumeInterruptedJob(prisma, storeId, jobId);
  assert.equal(resumed.resumed, true);
  const { result } = await runToCompletion(storeId, jobId, new FakeWritePort());
  assert.equal(result.status, "completed");
  assert.equal(result.succeeded, 3);
});

test("§7 — a crashed worker's item lease expires and the item is re-processed exactly once", async () => {
  const { storeId, jobId, products } = await queuedJob(3);
  const port = new FakeWritePort();

  // Simulate a crash mid-batch: one item stuck 'claimed' with a lease from the past.
  const stuck = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[0]! } });
  await prisma.bulkAssignmentItem.update({
    where: { id: stuck.id },
    data: { status: "claimed", claimedBy: "dead-worker", claimedAt: new Date(Date.now() - 10 * 60_000), leaseExpiresAt: new Date(Date.now() - 5 * 60_000) },
  });
  await prisma.bulkAssignmentJob.update({ where: { id: jobId }, data: { status: "running", workerToken: "dead-worker", leaseExpiresAt: new Date(Date.now() - 60_000) } });

  const { result } = await runToCompletion(storeId, jobId, port);
  assert.equal(result.status, "completed");
  assert.equal(result.succeeded + result.unchanged, 3);
  assert.equal(await prisma.bulkAssignmentItem.count({ where: { jobId, status: "claimed" } }), 0);
});

test("§7 — two concurrent requests never process the same item", async () => {
  const { storeId, jobId, products } = await queuedJob(20);
  const portA = new FakeWritePort();
  const portB = new FakeWritePort();

  await Promise.all([
    processAssignmentJob(prisma, storeId, jobId, { port: portA, workerId: "worker-A", shopEnforcementPolicyJson: ENFORCEMENT_DISABLED }),
    processAssignmentJob(prisma, storeId, jobId, { port: portB, workerId: "worker-B", shopEnforcementPolicyJson: ENFORCEMENT_DISABLED }),
  ]);
  await runToCompletion(storeId, jobId, portA);

  const items = await prisma.bulkAssignmentItem.findMany({ where: { jobId } });
  assert.equal(items.length, 20);
  assert.ok(items.every((i) => i.status === "succeeded" || i.status === "unchanged"), "every item reached a terminal success state exactly once");

  // No product's metafield was written by BOTH workers.
  const setByA = new Set(portA.calls.filter((c) => c.op === "set").map((c) => c.gid));
  const setByB = new Set(portB.calls.filter((c) => c.op === "set").map((c) => c.gid));
  const both = [...setByA].filter((g) => setByB.has(g));
  assert.equal(both.length, 0, `batches written by both workers: ${both.join(", ")}`);
  void products;
});

test("§1 — enforcement enabled BETWEEN batches pauses the job mid-run", async () => {
  const { storeId, jobId } = await queuedJob(60);
  const port = new FakeWritePort();

  // First invocation: enforcement disabled — processes a bounded number of batches.
  const first = await processAssignmentJob(prisma, storeId, jobId, {
    port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED, maxBatches: 1,
  });
  assert.equal(first.more, true);
  assert.ok(first.succeeded > 0 && first.succeeded < 60, "partial progress");

  // Enforcement is switched on before the next request.
  const second = await processAssignmentJob(prisma, storeId, jobId, {
    port, shopEnforcementPolicyJson: ENFORCEMENT_ENABLED,
  });
  assert.equal(second.refused?.reason, "enabled");
  assert.equal(second.succeeded, first.succeeded, "no further writes after enforcement was enabled");
  const job = await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: jobId } });
  assert.equal(job.status, "paused");

  // Turning it back off lets the job finish from exactly where it stopped.
  const { result } = await runToCompletion(storeId, jobId, port);
  assert.equal(result.status, "completed");
  assert.equal(result.succeeded, 60);
});

test("the processor refuses to run at all while shop enforcement is enabled", async () => {
  const { storeId, jobId } = await queuedJob(2);
  const port = new FakeWritePort();
  const result = await processAssignmentJob(prisma, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_ENABLED });
  assert.equal(result.refused?.reason, "enabled");
  assert.equal(port.calls.length, 0, "no Shopify calls made");
  assert.equal((await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: jobId } })).status, "paused");
});

test("§10 — 6,500-item job: bounded planning + materialization, no id list in the payload", async () => {
  const domain = makeShopDomain("catalog-proc");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const profile = await seedProfile(storeId, { name: "Bulk6500", currency: "USD" });

  const tSeed = performance.now();
  await seedManyCatalogProducts(storeId, 6500);
  const seedMs = performance.now() - tSeed;

  const tPlan = performance.now();
  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: profile.id, replaceExisting: false, idempotencyKey: "big",
  });
  assert.ok(dry.ok);
  const planMs = performance.now() - tPlan;
  assert.equal(dry.counts.totalMatched, 6500);
  assert.equal(dry.counts.eligible, 6500);
  assert.ok(dry.fingerprintBatches >= 13, "the target-state digest was streamed in bounded passes");
  assert.ok(Buffer.byteLength(JSON.stringify(dry)) < 2000, "the dry-run payload is counts + one digest, not 6,500 ids");

  const tApply = performance.now();
  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok, JSON.stringify(applied));
  const applyMs = performance.now() - tApply;
  assert.equal(applied.totalItems, 6500);
  assert.equal(applied.batchSize, 25);

  // eslint-disable-next-line no-console
  console.log(`[perf] 6,500: seed ${seedMs.toFixed(0)}ms | dry-run ${planMs.toFixed(0)}ms (${dry.fingerprintBatches} fingerprint passes) | materialize ${applyMs.toFixed(0)}ms`);
  const maxRemoteMs = 90_000;
  assert.ok(planMs < (isRemoteDatabase ? maxRemoteMs : 40_000));
  assert.ok(applyMs < (isRemoteDatabase ? maxRemoteMs : 40_000));

  const job = await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: dry.jobId } });
  assert.ok(job.selectionDescriptor.length < 500, `descriptor is ${job.selectionDescriptor.length} bytes, not a 6,500-id list`);
});

test(
  "§10 — full port round-trip stays linear in bounded 25-item batches",
  { skip: isRemoteDatabase && !runRemotePerfTests },
  async () => {
  // The 6,500-scale plan + materialization is proven above; here the full write path runs
  // at a representative scale (20 batches) — enough that a quadratic per-item cost or a
  // re-processing bug is obvious. The suite shares the project dev.sqlite, on which a
  // 6,500-row per-item write loop is minutes of I/O.
  const N = 500;
  const { storeId, jobId } = await queuedJob(N);
  const port = new FakeWritePort();
  const t0 = performance.now();
  const { result, invocations } = await runToCompletion(storeId, jobId, port, { maxBatches: 8 });
  const elapsed = performance.now() - t0;

  assert.equal(result.status, "completed");
  assert.equal((await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: jobId } })).succeeded, N);

  const readBatches = port.calls.filter((c) => c.op === "read").length;
  const setBatches = port.calls.filter((c) => c.op === "set").length;
  const readProducts = port.calls.filter((c) => c.op === "read").reduce((n, c) => n + (c.count ?? 0), 0);
  const setProducts = port.calls.filter((c) => c.op === "set").reduce((n, c) => n + (c.count ?? 0), 0);
  assert.equal(readProducts, N, "exactly one policy read per product — no re-reading");
  assert.equal(setProducts, N, "exactly one metafieldsSet per product — no quadratic re-processing");
  assert.equal(readBatches, Math.ceil(N / 25), "reads are batched at the Shopify cap");
  assert.equal(setBatches, Math.ceil(N / 25), "writes are batched at the Shopify cap");
  assert.ok(invocations >= 2, "the job spanned multiple bounded requests");

  const perItemMs = elapsed / N;
  // eslint-disable-next-line no-console
  console.log(`[perf] ${N}-item assignment: ${elapsed.toFixed(0)}ms, ${perItemMs.toFixed(2)}ms/item, ${invocations + 1} bounded requests, ${readBatches} read + ${setBatches} write round-trips`);
  // The exact read/write batch counts above are the real proof of linearity; this wall-
  // clock bound is loose because the suite runs files in parallel against one SQLite file.
  assert.ok(perItemMs < 120, `per-item cost ${perItemMs.toFixed(2)}ms is bounded (linear, not quadratic)`);
  },
);
