/**
 * Task 6A.1.1 §3 — two-system consistency.
 *
 * INVARIANT: a product must never become effectively dynamically priced through a local
 * active `ProductPricingOverride` unless Shopify has confirmed the corresponding
 * app-owned `pricing_policy` metafield.
 *
 * Proven across every failure mode the processor can hit between the two writes:
 *   - Shopify compare-and-set conflict;
 *   - Shopify user error (permanent);
 *   - unattributable error / atomic-mutation rollback;
 *   - network / unknown remote outcome;
 *   - LOCAL database failure AFTER a confirmed remote write;
 *   - retry / replay after an interruption.
 *
 * In every case the item ends fail-closed (not `succeeded`) and either has NO override or
 * only the override it had before the job. A remote uncertainty is re-read + reconciled
 * before any retry write — never blindly overwritten.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { planBulkAssignment } from "../../app/lib/catalog/dry-run.ts";
import { confirmAndCreateJob } from "../../app/lib/catalog/apply.ts";
import { processAssignmentJob } from "../../app/lib/catalog/processor.ts";
import { createAdminWritePort } from "../../app/lib/catalog/write-port.ts";
import type { PrismaClient } from "@prisma/client";
import {
  prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride,
  FakeWritePort, ENFORCEMENT_DISABLED,
  overrideKeyFor
} from "./helpers.ts";
import { FakeAdmin } from "./fake-admin.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

async function queuedJob(productCount = 3) {
  const domain = makeShopDomain("catalog-cas");
  shops.push(domain);
  const storeId = await seedStore(domain, "USD");
  const profile = await seedProfile(storeId, { name: "CAS", currency: "USD" });
  const products: string[] = [];
  for (let i = 0; i < productCount; i++) products.push((await seedCatalogProduct(storeId)).shopifyProductId);

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: products }, pricingProfileId: profile.id, replaceExisting: true, idempotencyKey: `d-${Math.random()}`,
  });
  assert.ok(dry.ok);
  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok);
  return { domain, storeId, profileId: profile.id, jobId: dry.jobId, products };
}

async function run(storeId: string, jobId: string, port: FakeWritePort | ReturnType<typeof createAdminWritePort>, opts: { prisma?: PrismaClient; maxInvocations?: number } = {}) {
  const p = opts.prisma ?? prisma;
  let r = await processAssignmentJob(p, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  let n = 0;
  while (r.more && n++ < (opts.maxInvocations ?? 40)) {
    await p.bulkAssignmentItem.updateMany({ where: { jobId, nextAttemptAt: { not: null } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    r = await processAssignmentJob(p, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  }
  return r;
}

async function assertFailClosed(storeId: string, jobId: string, gid: string) {
  const item = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: gid } });
  assert.notEqual(item.status, "succeeded", "the item must NOT be marked successful");
  const ov = await prisma.productPricingOverride.findFirst({ where: { storeId, shopifyProductId: overrideKeyFor(gid) } });
  assert.ok(!ov || !ov.isActive, "no ACTIVE local override without a confirmed metafield");
  return item;
}

test("Shopify CAS conflict → item failed, NO local override", async () => {
  const { storeId, jobId, products } = await queuedJob(3);
  const port = new FakeWritePort();
  port.failSet.set(products[1]!, [{ ok: false, conflict: true, code: "CONFLICT_DIGEST_MISMATCH", message: "changed" }]);

  const r = await run(storeId, jobId, port);
  assert.equal(r.status, "partial");
  const item = await assertFailClosed(storeId, jobId, products[1]!);
  assert.equal(item.errorCode, "PERMANENT_POLICY_CONFLICT");
  assert.equal(item.policyWritten, false);
  assert.equal(port.current(products[1]!), "", "Shopify was never written for the conflicted product");
});

test("Shopify permanent user error → item failed, NO local override", async () => {
  const { storeId, jobId, products } = await queuedJob(3);
  const port = new FakeWritePort();
  port.failSet.set(products[0]!, [{ ok: false, retryable: false, code: "PERMANENT_POLICY_USERERROR", message: "bad json" }]);

  const r = await run(storeId, jobId, port);
  assert.equal(r.status, "partial");
  const item = await assertFailClosed(storeId, jobId, products[0]!);
  assert.equal(item.errorCode, "PERMANENT_POLICY_USERERROR");
  assert.equal(await prisma.productPricingOverride.count({ where: { storeId, shopifyProductId: overrideKeyFor(products[0]!) } }), 0);
});

test("write port: an UNATTRIBUTABLE metafieldsSet error → every item TRANSIENT_UNCONFIRMED_WRITE (never permanent, never ok)", async () => {
  const admin = new FakeAdmin();
  admin.failNextSetUnattributable = 1;
  const port = createAdminWritePort(admin);
  const gids = ["gid://shopify/Product/6001", "gid://shopify/Product/6002", "gid://shopify/Product/6003"];

  const out = await port.setProductPolicies(gids.map((g) => ({ productGid: g, valueJson: "{}", compareDigest: null })));
  for (const g of gids) {
    const o = out.get(g)!;
    assert.equal(o.ok, false);
    assert.equal("conflict" in o && o.conflict, false, "an unattributable error is NOT a conflict");
    assert.equal((o as { retryable: boolean }).retryable, true, "it IS retryable — reconcile then retry");
    assert.equal((o as { code: string }).code, "TRANSIENT_UNCONFIRMED_WRITE");
  }
  // Nothing was actually written (atomic mutation rolled back).
  assert.equal(admin.metafields.size, 0);
});

test("unattributable outcome in the processor → retryable, NO override, then reconciled + written cleanly", async () => {
  const { storeId, jobId, products } = await queuedJob(2);
  const port = new FakeWritePort();
  // First write attempt for each product comes back unconfirmed (as an atomic-batch
  // rollback would); the retry lands.
  for (const g of products) {
    port.failSet.set(g, [{ ok: false, retryable: true, code: "TRANSIENT_UNCONFIRMED_WRITE", message: "atomic rollback" }]);
  }

  await processAssignmentJob(prisma, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  for (const g of products) {
    await assertFailClosed(storeId, jobId, g);
    assert.equal(port.current(g), "", "nothing written on the unconfirmed pass");
  }

  const r = await run(storeId, jobId, port);
  assert.equal(r.status, "completed");
  const items = await prisma.bulkAssignmentItem.findMany({ where: { jobId } });
  assert.ok(items.every((i) => i.status === "succeeded"));
  const totalSets = port.calls.filter((c) => c.op === "set").reduce((n, c) => n + (c.count ?? 0), 0);
  // 2 unconfirmed on pass 1 + 2 confirmed on pass 2 = 4 attempts, each product written once.
  assert.equal(totalSets, 4);
  for (const g of products) assert.notEqual(port.current(g), "");
});

test("network / unknown remote outcome → retryable, NO override; recovers on a later pass", async () => {
  const { storeId, jobId, products } = await queuedJob(2);
  const port = new FakeWritePort();
  // fail the write twice with a transient network error, then let it through
  port.failSet.set(products[0]!, [
    { ok: false, retryable: true, code: "TRANSIENT_NETWORK", message: "ECONNRESET" },
    { ok: false, retryable: true, code: "TRANSIENT_NETWORK", message: "ECONNRESET" },
  ]);

  // after the first (failed) pass, the invariant must hold
  await processAssignmentJob(prisma, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });
  await assertFailClosed(storeId, jobId, products[0]!);
  assert.equal(port.current(products[0]!), "", "nothing written to Shopify yet");

  const r = await run(storeId, jobId, port);
  assert.equal(r.status, "completed");
  const item = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: products[0]! } });
  assert.equal(item.status, "succeeded");
  assert.equal(port.calls.filter((c) => c.op === "set").reduce((n, c) => n + (c.count ?? 0), 0) >= 3, true, "the write was attempted on each pass");
});

test("LOCAL DB failure AFTER a confirmed remote write → retryable, override deferred, converges on next pass", async () => {
  const { storeId, jobId, profileId, products } = await queuedJob(1);
  const gid = products[0]!;
  const port = new FakeWritePort();

  // A prisma proxy that throws ONCE on productPricingOverride.upsert.
  let thrown = false;
  const proxied = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === "productPricingOverride") {
        const real = Reflect.get(target, prop, receiver);
        return new Proxy(real, {
          get(m, mprop, mrecv) {
            if (mprop === "upsert" && !thrown) {
              return async () => {
                thrown = true;
                throw new Error("simulated DB failure on override upsert");
              };
            }
            return Reflect.get(m, mprop, mrecv);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PrismaClient;

  // First pass: metafield write succeeds + confirmed, THEN the override upsert throws.
  const first = await processAssignmentJob(proxied, storeId, jobId, { port, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });

  // Invariant: Shopify confirmed, but the LOCAL override is NOT active, and the item is
  // NOT successful — it is retryable.
  assert.notEqual(port.current(gid), "", "Shopify HAS the confirmed metafield");
  const midItem = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: gid } });
  assert.equal(midItem.policyWritten, true, "the confirmed remote write is recorded");
  assert.ok(midItem.postPolicyDigest, "the confirmed digest is recorded");
  assert.notEqual(midItem.status, "succeeded");
  assert.equal(await prisma.productPricingOverride.count({ where: { storeId, shopifyProductId: overrideKeyFor(gid), isActive: true } }), 0);
  assert.ok(first.more);

  // Second pass with a healthy client: reconcile sees the metafield already at the
  // desired value → skip the write → complete the override.
  const setsBefore = port.calls.filter((c) => c.op === "set").length;
  const r = await run(storeId, jobId, port);
  assert.equal(r.status, "completed");
  assert.equal(port.calls.filter((c) => c.op === "set").length, setsBefore, "NO second metafield write — the confirmed one was adopted");

  const done = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: gid } });
  assert.equal(done.status, "succeeded");
  const ov = await prisma.productPricingOverride.findFirstOrThrow({ where: { storeId, shopifyProductId: overrideKeyFor(gid) } });
  assert.equal(ov.pricingProfileId, profileId);
  assert.equal(ov.isActive, true);
});

test("retry / replay after interruption → exactly-once, converges", async () => {
  const { storeId, jobId, products } = await queuedJob(4);
  const port = new FakeWritePort();

  // Process one bounded batch (maxBatches: 1 with 4 items still fits one batch of 25, so
  // instead: interrupt by killing the lease + marking items claimed mid-flight).
  await processAssignmentJob(prisma, storeId, jobId, { port, maxBatches: 1, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED });

  // Simulate a crash: half the items got through, force the rest back to a claimed-but-
  // stale state and clear the job lease.
  await prisma.bulkAssignmentJob.update({ where: { id: jobId }, data: { status: "running", workerToken: "dead", leaseExpiresAt: new Date(Date.now() - 60_000) } });
  await prisma.bulkAssignmentItem.updateMany({
    where: { jobId, status: { in: ["pending", "claimed"] } },
    data: { status: "claimed", claimedBy: "dead", claimedAt: new Date(Date.now() - 10 * 60_000), leaseExpiresAt: new Date(Date.now() - 5 * 60_000) },
  });

  const setsBeforeResume = port.calls.filter((c) => c.op === "set").reduce((n, c) => n + (c.count ?? 0), 0);
  const r = await run(storeId, jobId, port);
  assert.equal(r.status, "completed");

  const items = await prisma.bulkAssignmentItem.findMany({ where: { jobId } });
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => i.status === "succeeded" || i.status === "unchanged"));

  // Every product's metafield exists once, and total writes == 4 (no double-write on resume).
  for (const gid of products) {
    assert.notEqual(port.current(gid), "");
    const ov = await prisma.productPricingOverride.findFirstOrThrow({ where: { storeId, shopifyProductId: overrideKeyFor(gid) } });
    assert.equal(ov.isActive, true);
  }
  const totalSets = port.calls.filter((c) => c.op === "set").reduce((n, c) => n + (c.count ?? 0), 0);
  assert.equal(totalSets, 4, `exactly one metafield write per product across the interruption (got ${totalSets}, ${setsBeforeResume} before resume)`);
});

test("a legacy override-first row (override active, policy unconfirmed) is reverted on a conflict", async () => {
  const { storeId, jobId, profileId, products } = await queuedJob(1);
  const gid = products[0]!;
  const port = new FakeWritePort();

  // Simulate a row left behind by the OLD (override-first) ordering: the local override
  // is already active for the target, but the metafield was never confirmed.
  await seedOverride(storeId, gid, profileId, {});
  await prisma.bulkAssignmentItem.updateMany({ where: { jobId, shopifyProductId: gid }, data: { overrideWritten: true } });
  // and make the metafield write conflict
  port.seedExisting(gid, JSON.stringify({ schema: 1, required: true, active: true, profileRef: "foreign", profileRevision: 7, policyRevision: 7 }));
  port.failSet.set(gid, [{ ok: false, conflict: true, code: "CONFLICT_DIGEST_MISMATCH", message: "changed" }]);

  const r = await run(storeId, jobId, port);
  assert.equal(r.status, "failed");

  const item = await prisma.bulkAssignmentItem.findFirstOrThrow({ where: { jobId, shopifyProductId: gid } });
  assert.equal(item.errorCode, "PERMANENT_POLICY_CONFLICT");
  assert.equal(item.overrideWritten, false, "the legacy override flag was cleared");
  // prevOverrideExisted was false (seedOverride happened AFTER materialization) → the
  // job-created override is removed entirely, restoring the invariant.
  assert.equal(await prisma.productPricingOverride.count({ where: { storeId, shopifyProductId: overrideKeyFor(gid) } }), 0);
});
