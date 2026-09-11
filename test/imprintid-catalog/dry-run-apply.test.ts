/**
 * Task 6A §5, §6, §11 — dry-run planning and the guarded apply.
 *
 * Proves: deterministic counts; inactive / wrong-currency profile blocked; replacement
 * flag semantics; the apply is rejected on an expired, revision-changed, catalog-changed,
 * or cross-shop dry run, and on a tampered fingerprint; enforcement-enabled blocks apply.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { planBulkAssignment } from "../../app/lib/catalog/dry-run.ts";
import { confirmAndCreateJob } from "../../app/lib/catalog/apply.ts";
import {
  parseSelectionDescriptor,
  SelectionError,
  filterNarrowsSelection,
  selectionTargetsWholeCatalog,
} from "../../app/lib/catalog/selection.ts";
import { resolveStoreProducts } from "../../app/lib/catalog/tenancy.ts";
import {
  prisma, makeShopDomain, seedStore, cleanupShops, seedProfile, seedCatalogProduct, seedOverride,
  ENFORCEMENT_DISABLED, ENFORCEMENT_ENABLED,
} from "./helpers.ts";

const shops: string[] = [];
after(async () => {
  await cleanupShops(shops);
  await prisma.$disconnect();
});

async function scenario(opts: { shopCurrency?: string } = {}) {
  const domain = makeShopDomain("catalog-dryrun");
  shops.push(domain);
  const storeId = await seedStore(domain, opts.shopCurrency ?? "USD");
  return { domain, storeId };
}

test("deterministic counts: eligible / unchanged / alreadyAssigned / replacement / invalid / skipped", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId, { name: "Target", currency: "USD" });
  const other = await seedProfile(storeId, { name: "Other", currency: "USD" });

  const unassigned = await seedCatalogProduct(storeId, { title: "A" });
  const alreadyTarget = await seedCatalogProduct(storeId, { title: "B", policySyncedAt: new Date() });
  await seedOverride(storeId, alreadyTarget.shopifyProductId, target.id);
  const onOther = await seedCatalogProduct(storeId, { title: "C" });
  await seedOverride(storeId, onOther.shopifyProductId, other.id);
  const removed = await seedCatalogProduct(storeId, { title: "D", removedFromShopifyAt: new Date() });

  const ids = [unassigned, alreadyTarget, onOther, removed].map((p) => p.shopifyProductId);

  const noReplace = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids }, pricingProfileId: target.id, replaceExisting: false,
    idempotencyKey: "k-noreplace",
  });
  assert.ok(noReplace.ok);
  assert.deepEqual(noReplace.counts, {
    totalMatched: 3, // removed product is filtered out by iterateSelection
    eligible: 1,
    unchanged: 1,
    verificationRequired: 0,
    alreadyAssigned: 1,
    replacementRequired: 0,
    invalid: 0,
    skipped: 1,
    estimatedOperations: 1,
  });

  const withReplace = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids }, pricingProfileId: target.id, replaceExisting: true,
    idempotencyKey: "k-replace",
  });
  assert.ok(withReplace.ok);
  assert.equal(withReplace.counts.replacementRequired, 1);
  assert.equal(withReplace.counts.skipped, 0);
  assert.equal(withReplace.counts.estimatedOperations, 2);
});

test("Task 6A.3B §1 — a matching override whose policy is not locally synced is verification-required, NOT a planned write", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId, { name: "Target", currency: "USD" });

  // LNY01's former state: an active bare-ID override already on the target profile, but
  // the CatalogProduct row still says "unassigned" and policy was never synced locally.
  const stale = await seedCatalogProduct(storeId, { title: "LNY01", coverageStatus: "unassigned", policySyncedAt: null });
  await seedOverride(storeId, stale.shopifyProductId, target.id);
  // A genuinely unassigned product, for contrast.
  const fresh = await seedCatalogProduct(storeId, { title: "fresh" });

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: [stale.shopifyProductId, fresh.shopifyProductId] },
    pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "verif",
  });
  assert.ok(dry.ok);
  assert.equal(dry.counts.verificationRequired, 1, "the stale-coverage product is verification-required");
  assert.equal(dry.counts.eligible, 1, "only the genuinely unassigned product is eligible");
  assert.equal(dry.counts.unchanged, 0);
  assert.equal(dry.counts.estimatedOperations, 1, "estimated writes cover ONLY the eligible product — not the verification one");

  // apply still materializes the verification item so the processor settles it.
  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(applied.totalItems, 2);
});

test("Task 6A.3B §1 — an already-synced matching override is `unchanged`, and estimatedOperations is 0 for a pure no-op selection", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId, { name: "Target", currency: "USD" });
  const done = await seedCatalogProduct(storeId, { title: "done", policySyncedAt: new Date() });
  await seedOverride(storeId, done.shopifyProductId, target.id);

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "ids", ids: [done.shopifyProductId] },
    pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "noop",
  });
  assert.ok(dry.ok);
  assert.equal(dry.counts.unchanged, 1);
  assert.equal(dry.counts.verificationRequired, 0);
  assert.equal(dry.counts.estimatedOperations, 0, "the processor will perform zero writes → zero estimated operations");
});

test("selectionTargetsWholeCatalog — `all`, an empty filter, and a modifier-only filter all count; a narrowing filter does not", () => {
  const asFilter = (filter: Record<string, unknown>) => {
    const sel = parseSelectionDescriptor({ kind: "filter", filter });
    if (sel.kind !== "filter") throw new Error("expected a filter selection");
    return sel;
  };

  assert.equal(selectionTargetsWholeCatalog({ kind: "all" }), true);
  assert.equal(selectionTargetsWholeCatalog(asFilter({})), true);
  // `skuMatch` / `includeRemoved` are modifiers, not narrowing filters.
  assert.equal(selectionTargetsWholeCatalog(asFilter({ skuMatch: "contains" })), true);
  assert.equal(filterNarrowsSelection(asFilter({ skuMatch: "contains" }).filter), false);

  for (const narrowing of [{ text: "tee" }, { vendor: "Acme" }, { coverageStatus: "unassigned" }, { tag: "sale" }, { productType: "Apparel" }]) {
    const sel = asFilter(narrowing);
    assert.equal(selectionTargetsWholeCatalog(sel), false, JSON.stringify(narrowing));
    assert.equal(filterNarrowsSelection(sel.filter), true, JSON.stringify(narrowing));
  }
  // an explicit id list is always bounded
  assert.equal(selectionTargetsWholeCatalog({ kind: "ids", ids: ["gid://shopify/Product/1"] }), false);
});

test("an inactive profile is a blocking error", async () => {
  const { domain, storeId } = await scenario();
  const inactive = await seedProfile(storeId, { isActive: false });
  await seedCatalogProduct(storeId);
  const r = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: inactive.id, replaceExisting: false, idempotencyKey: "k",
  });
  assert.ok(r.ok);
  assert.ok(r.blockingErrors.some((e) => /inactive/.test(e)));
});

test("a currency-mismatched profile is a blocking error", async () => {
  const { domain, storeId } = await scenario({ shopCurrency: "USD" });
  const eur = await seedProfile(storeId, { currency: "EUR" });
  await seedCatalogProduct(storeId);
  const r = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: eur.id, replaceExisting: false, idempotencyKey: "k",
  });
  assert.ok(r.ok);
  assert.ok(r.blockingErrors.some((e) => /currency/i.test(e)));
});

test("apply succeeds with fresh, matching evidence and materializes items", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId);
  await seedCatalogProduct(storeId);
  await seedCatalogProduct(storeId);

  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "apply-ok",
  });
  assert.ok(dry.ok);

  const applied = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint,
    shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(applied.totalItems, 2);
  const job = await prisma.bulkAssignmentJob.findFirstOrThrow({ where: { id: dry.jobId } });
  assert.equal(job.status, "queued");
  assert.equal(await prisma.bulkAssignmentItem.count({ where: { jobId: dry.jobId } }), 2);
});

test("apply rejects a tampered fingerprint (browser-edited counts/lists)", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId);
  await seedCatalogProduct(storeId);
  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "tamper",
  });
  assert.ok(dry.ok);
  const r = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: "drf_deadbeef", shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "FINGERPRINT_ECHO_MISMATCH");
});

test("apply rejects an expired dry run", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId);
  await seedCatalogProduct(storeId);
  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "exp",
  });
  assert.ok(dry.ok);
  await prisma.bulkAssignmentJob.update({ where: { id: dry.jobId }, data: { dryRunExpiresAt: new Date(Date.now() - 1000) } });
  const r = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "DRY_RUN_EXPIRED");
});

test("apply rejects a dry run whose profile revision changed", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId, { revision: 1 });
  await seedCatalogProduct(storeId);
  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "rev",
  });
  assert.ok(dry.ok);
  await prisma.pricingProfile.update({ where: { id: target.id }, data: { revision: 2 } });
  const r = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PROFILE_REVISION_CHANGED");
});

test("apply rejects a dry run after the catalog changed", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId);
  await seedCatalogProduct(storeId);
  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "cat",
  });
  assert.ok(dry.ok);
  await seedCatalogProduct(storeId, { title: "new arrival" }); // catalog grew
  const r = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.equal(r.ok, false);
  assert.ok(["CATALOG_CHANGED", "TARGET_CHANGED"].includes(r.code));
});

test("apply rejects another shop trying to use this shop's dry run", async () => {
  const a = await scenario();
  const b = await scenario();
  const target = await seedProfile(a.storeId);
  await seedCatalogProduct(a.storeId);
  const dry = await planBulkAssignment(prisma, {
    storeId: a.storeId, shopDomain: a.domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "xshop",
  });
  assert.ok(dry.ok);
  // Shop B presents shop A's jobId.
  const r = await confirmAndCreateJob(prisma, {
    storeId: b.storeId, shopDomain: b.domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_DISABLED,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "DRY_RUN_NOT_FOUND");
});

test("apply refuses while shop enforcement is enabled", async () => {
  const { domain, storeId } = await scenario();
  const target = await seedProfile(storeId);
  await seedCatalogProduct(storeId);
  const dry = await planBulkAssignment(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    selection: { kind: "all" }, pricingProfileId: target.id, replaceExisting: false, idempotencyKey: "enf",
  });
  assert.ok(dry.ok);
  const r = await confirmAndCreateJob(prisma, {
    storeId, shopDomain: domain, shopCurrency: "USD",
    jobId: dry.jobId, echoedFingerprint: dry.dryRunFingerprint, shopEnforcementPolicyJson: ENFORCEMENT_ENABLED,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ENFORCEMENT_ENABLED");
});

test("a malformed product id in an explicit selection is rejected before any planning", () => {
  assert.throws(() => parseSelectionDescriptor({ kind: "ids", ids: ["not-a-gid"] }), SelectionError);
  assert.throws(() => parseSelectionDescriptor({ kind: "ids", ids: ["gid://shopify/Order/5"] }), SelectionError);
  // a valid explicit list is accepted + canonicalized
  const ok = parseSelectionDescriptor({ kind: "ids", ids: ["123", "gid://shopify/Product/456"] });
  assert.deepEqual(ok, { kind: "ids", ids: ["gid://shopify/Product/123", "gid://shopify/Product/456"] });
});

test("a foreign product id is reported as unknown, never acted on", async () => {
  const a = await scenario();
  const b = await scenario();
  const mine = await seedCatalogProduct(a.storeId);
  const theirs = await seedCatalogProduct(b.storeId);

  const res = await resolveStoreProducts(prisma, a.storeId, [mine.shopifyProductId, theirs.shopifyProductId, "gid://shopify/Product/99999999"]);
  assert.deepEqual(res.matched.map((m) => m.shopifyProductId), [mine.shopifyProductId]);
  assert.equal(res.rejected.length, 2);
  assert.ok(res.rejected.every((r) => r.reason === "unknown"));
});
