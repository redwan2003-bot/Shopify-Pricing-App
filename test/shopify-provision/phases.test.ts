/**
 * Task 5B.3B.2 — the phased provisioner ORCHESTRATION (`scripts/shopify/phases.mjs`),
 * driven by a fake Admin client + fake IO. No network, no filesystem, no Prisma.
 *
 * Proves: `--check` mutates nothing and never exits early; `--prepare` creates only the
 * documented resources with enforcement disabled and never touches the Cart Transform /
 * Validation; `--activate` refuses to run before fingerprint verification; `--enable-pilot`
 * refuses to run before activation; every phase is idempotent on a rerun; and no receipt
 * ever carries a token or secret.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  phaseCheck,
  phasePrepare,
  phaseActivate,
  phaseEnablePilot,
  phaseRollbackCheck,
  StopError,
} from "../../scripts/shopify/phases.mjs";
import { userErrors } from "../../scripts/shopify/runtime.mjs";
import {
  parseShopEnforcementPolicy,
  parseProductPricingPolicy,
} from "../../app/lib/pricing-api/policy-metafields.ts";
import { ADJ_PRODUCT_TITLE, ADJ_PRODUCT_TAGS } from "../../scripts/shopify/constants.mjs";

const TRANSFORM_FN = "gid://shopify/ShopifyFunction/tf-1";
const VALIDATION_FN = "gid://shopify/ShopifyFunction/vf-1";
const ADJ_VARIANT = "gid://shopify/ProductVariant/2";
const ADJ_PRODUCT = "gid://shopify/Product/1";
const SHOP_ID = "gid://shopify/Shop/1";
const LNY01 = "gid://shopify/Product/9442404663548";

/** A stateful fake Admin client: records every call, distinguishes queries from
 * mutations, and reflects `metafieldsSet` writes back on the read-back queries. */
function makeFakeGql(seed: { shopPolicy?: unknown; productPolicy?: unknown } = {}) {
  const calls: Array<{ op: "query" | "mutation"; name: string; query: string; vars: unknown }> = [];
  const store: { shopPolicy: unknown; productPolicy: unknown } = {
    shopPolicy: seed.shopPolicy ?? null,
    productPolicy: seed.productPolicy ?? null,
  };
  let productCreated = false;
  let transformCreated = false;
  let validationCreated = false;

  async function gql(query: string, vars: unknown = {}) {
    const isMutation = /^\s*mutation/.test(query);
    const nameMatch = query.match(/(?:mutation|query)[^{(]*[({]\s*([A-Za-z]+)/);
    const name = nameMatch ? nameMatch[1] : "?";
    calls.push({ op: isMutation ? "mutation" : "query", name, query, vars });

    if (/productCreate/.test(query)) {
      productCreated = true;
      return { productCreate: { product: { id: ADJ_PRODUCT, variants: { nodes: [{ id: ADJ_VARIANT }] } }, userErrors: [] } };
    }
    if (/productVariantsBulkUpdate/.test(query)) {
      return { productVariantsBulkUpdate: { productVariants: [{ id: ADJ_VARIANT, price: "0.01", inventoryPolicy: "CONTINUE" }], userErrors: [] } };
    }
    if (/productUpdate/.test(query)) {
      return { productUpdate: { product: { id: ADJ_PRODUCT }, userErrors: [] } };
    }
    if (/metafieldDefinitionCreate/.test(query)) {
      return { metafieldDefinitionCreate: { createdDefinition: { id: "gid://shopify/MetafieldDefinition/x" }, userErrors: [] } };
    }
    if (/metafieldsSet/.test(query)) {
      const m = (vars as { m: Array<{ key: string; value: string; ownerId: string }> }).m;
      for (const entry of m) {
        const parsed = JSON.parse(entry.value);
        if (entry.key === "enforcement_policy") store.shopPolicy = parsed;
        if (entry.key === "pricing_policy") store.productPolicy = parsed;
      }
      return {
        metafieldsSet: {
          metafields: m.map((e, i) => ({ id: `gid://shopify/Metafield/${i}`, key: e.key, namespace: "$app:imprintid" })),
          userErrors: [],
        },
      };
    }
    if (/cartTransformCreate/.test(query)) {
      transformCreated = true;
      return { cartTransformCreate: { cartTransform: { id: "gid://shopify/CartTransform/OURS", blockOnFailure: true }, userErrors: [] } };
    }
    if (/validationCreate/.test(query)) {
      validationCreated = true;
      return { validationCreate: { validation: { id: "gid://shopify/Validation/OURS", title: "ImprintID Dynamic Pricing Validation", enabled: true, blockOnFailure: true }, userErrors: [] } };
    }
    if (/validationUpdate/.test(query)) {
      return { validationUpdate: { validation: { id: "gid://shopify/Validation/OURS", enabled: true, blockOnFailure: true }, userErrors: [] } };
    }
    // read-back queries
    if (/enforcement_policy/.test(query) && /pricing_policy/.test(query)) {
      return {
        shop: { metafield: store.shopPolicy ? { jsonValue: store.shopPolicy } : null },
        product: { metafield: store.productPolicy ? { jsonValue: store.productPolicy } : null },
      };
    }
    if (/enforcement_policy/.test(query)) {
      return { shop: { metafield: store.shopPolicy ? { jsonValue: store.shopPolicy } : null } };
    }
    return {};
  }

  return {
    gql,
    calls,
    store,
    get productCreated() {
      return productCreated;
    },
    get transformCreated() {
      return transformCreated;
    },
    get validationCreated() {
      return validationCreated;
    },
    mutations() {
      return calls.filter((c) => c.op === "mutation");
    },
  };
}

function makeIo(over: Record<string, unknown> = {}) {
  let receipt: Record<string, unknown> | null = (over.receipt as Record<string, unknown>) ?? null;
  const written: string[] = [];
  return {
    userErrors,
    parseShopEnforcementPolicy,
    parseProductPricingPolicy,
    receiptPath: () => "/tmp/fake-receipt.json",
    readReceipt: () => receipt,
    readSecretFingerprints: over.readSecretFingerprints ?? (() => ({ appServer: "00000000", transform: "00000000", validation: "00000000" })),
    writeSigningEnv: over.writeSigningEnv ?? (() => "cafef00d"),
    writeReceipt: (patch: Record<string, unknown>) => {
      written.push(JSON.stringify(patch));
      receipt = {
        ...(receipt || {}),
        ...patch,
        resources: { ...(((receipt || {}) as Record<string, unknown>).resources || {}), ...((patch.resources as Record<string, unknown>) || {}) },
        updatedAt: "2026-09-02T00:00:00.000Z",
      };
      return receipt;
    },
    _receipt: () => receipt,
    _written: () => written,
  };
}

function baseState(over: Record<string, unknown> = {}) {
  return {
    shopId: SHOP_ID,
    shopName: "ImprintID Pricing Development",
    shopCurrency: "USD",
    profileCurrency: "USD",
    app: { title: "ImprintID Dynamic Pricing", apiKey: "d0d1f8d2c664325e5472f15b4fae3ac4" },
    receipt: null,
    shopPolicyJson: null,
    lny01PolicyJson: null,
    shopPolicyDefinitionId: null,
    productPolicyDefinitionId: null,
    functions: [
      { id: TRANSFORM_FN, title: "ImprintID Cart Pricing", apiType: "cart_transform", app: "ImprintID Dynamic Pricing" },
      { id: VALIDATION_FN, title: "imprintid-cart-validation", apiType: "cart_checkout_validation", app: "ImprintID Dynamic Pricing" },
    ],
    cartTransforms: [],
    validations: [],
    adjustmentProductMatches: [],
    ...over,
  };
}

const okAdjMatch = () => [
  {
    id: ADJ_PRODUCT,
    title: ADJ_PRODUCT_TITLE,
    status: "ACTIVE",
    onlineStoreUrl: null,
    tags: [...ADJ_PRODUCT_TAGS],
    variants: [{ id: ADJ_VARIANT, price: "0.01", inventoryPolicy: "CONTINUE", taxable: false, inventoryItem: { tracked: false, requiresShipping: false } }],
  },
];
const GOOD_SHOP = (enabled: boolean) => ({
  schema: 1,
  mode: "pilot",
  enabled,
  adjustmentVariantGid: ADJ_VARIANT,
  installBinding: "dev-imprintid-pricing-development-pilot-1",
  policyRevision: 1,
});
const GOOD_PROD = {
  schema: 1,
  required: true,
  active: true,
  profileRef: "cmtb2ffnz0002q1mw7d2hol5k",
  profileRevision: 1,
  policyRevision: 1,
};
const MATCHING_FP = () => ({ appServer: "abcd1234", transform: "abcd1234", validation: "abcd1234" });

const silent = () => {};

// --- check ------------------------------------------------------------------------

test("phaseCheck: performs ZERO mutations and never exits early (reports even with no adjustment product)", async () => {
  const f = makeFakeGql();
  const io = makeIo();
  const lines: string[] = [];
  const res = await phaseCheck({ state: baseState(), gql: f.gql, io, log: (s: string) => lines.push(String(s)) });
  assert.equal(res.mutated, false);
  assert.equal(f.mutations().length, 0, "no mutations from --check");
  const out = lines.join("\n");
  assert.ok(/CURRENT STATE/.test(out));
  assert.ok(/PLANNED --prepare MUTATIONS/.test(out));
  assert.ok(/PLANNED --activate MUTATIONS/.test(out));
  assert.ok(/CURRENCY READINESS/.test(out));
  assert.ok(/GO \/ NO-GO/.test(out));
  assert.ok(/adjustment product : absent/.test(out), "did NOT exit early on a missing adjustment product");
});

// --- prepare ---------------------------------------------------------------------

test("phasePrepare: creates ONLY the documented resources, enforcement DISABLED, and NEVER the Cart Transform / Validation", async () => {
  const f = makeFakeGql();
  const io = makeIo();
  const res = await phasePrepare({ state: baseState(), gql: f.gql, io, log: silent });

  const muts = f.mutations().map((m) => m.name || m.query.match(/\b(\w+)\(/)?.[1]);
  const kinds = f.mutations().map((m) => (m.query.match(/(productCreate|productVariantsBulkUpdate|productUpdate|metafieldDefinitionCreate|metafieldsSet|cartTransformCreate|validationCreate|validationUpdate)/) || [])[1]);
  assert.ok(kinds.includes("productCreate"));
  assert.ok(kinds.includes("productVariantsBulkUpdate"));
  assert.ok(kinds.includes("metafieldDefinitionCreate"));
  assert.ok(kinds.includes("metafieldsSet"));
  assert.ok(!kinds.includes("cartTransformCreate"), "prepare must NOT create the Cart Transform");
  assert.ok(!kinds.includes("validationCreate"), "prepare must NOT create a Validation");
  assert.equal(f.transformCreated, false);
  assert.equal(f.validationCreated, false);

  const shop = parseShopEnforcementPolicy(f.store.shopPolicy);
  assert.ok(shop, "shop policy parses");
  assert.equal(shop!.enabled, false, "enforcement is DISABLED after --prepare");
  assert.equal(shop!.mode, "pilot");
  assert.ok(parseProductPricingPolicy(f.store.productPolicy), "LNY01 pricing_policy parses");

  assert.equal(res.receipt.phaseReached, "prepared");
  void muts;
});

test("phasePrepare: the receipt carries a fingerprint but NEVER a secret or token", async () => {
  const f = makeFakeGql();
  const io = makeIo();
  await phasePrepare({ state: baseState(), gql: f.gql, io, log: silent });
  const receipt = io._receipt()!;
  const json = JSON.stringify(receipt);
  assert.equal(receipt.secretFingerprint, "cafef00d");
  assert.equal(/"secret"|accessToken|shpat_|IMPRINTID_CART_SIGNING_SECRET/.test(json), false, json);
});

test("phasePrepare: a rerun on the converged store is idempotent — no second productCreate", async () => {
  const converged = baseState({
    adjustmentProductMatches: okAdjMatch(),
    shopPolicyDefinitionId: "d1",
    productPolicyDefinitionId: "d2",
    shopPolicyJson: GOOD_SHOP(false),
    lny01PolicyJson: GOOD_PROD,
    receipt: { phaseReached: "prepared" },
  });
  const f = makeFakeGql({ shopPolicy: GOOD_SHOP(false), productPolicy: GOOD_PROD });
  const io = makeIo({ receipt: { phaseReached: "prepared" } });
  await phasePrepare({ state: converged, gql: f.gql, io, log: silent });
  const kinds = f.mutations().map((m) => (m.query.match(/(productCreate|metafieldDefinitionCreate)/) || [])[1]).filter(Boolean);
  assert.deepEqual(kinds, [], "no create mutations on a converged rerun");
  assert.equal(f.productCreated, false);
});

test("phasePrepare: STOPS on a foreign Cart Transform (never proceeds)", async () => {
  const f = makeFakeGql();
  const io = makeIo();
  await assert.rejects(
    () =>
      phasePrepare({
        state: baseState({ cartTransforms: [{ id: "FOREIGN", functionId: "someone-else", blockOnFailure: true }] }),
        gql: f.gql,
        io,
        log: silent,
      }),
    (e) => e instanceof StopError && /blocked/.test((e as Error).message),
  );
  assert.equal(f.mutations().length, 0);
});

// --- activate --------------------------------------------------------------------

function preparedState(over: Record<string, unknown> = {}) {
  return baseState({
    receipt: { phaseReached: "prepared", resources: { adjustmentVariantId: ADJ_VARIANT } },
    adjustmentProductMatches: okAdjMatch(),
    shopPolicyDefinitionId: "d1",
    productPolicyDefinitionId: "d2",
    shopPolicyJson: GOOD_SHOP(false),
    lny01PolicyJson: GOOD_PROD,
    ...over,
  });
}

test("phaseActivate: REFUSES to run before signing-secret fingerprint verification", async () => {
  const f = makeFakeGql();
  const io = makeIo({ readSecretFingerprints: () => ({ appServer: "00000000", transform: "00000000", validation: "00000000" }) });
  await assert.rejects(
    () => phaseActivate({ state: preparedState(), gql: f.gql, io, log: silent }),
    (e) => e instanceof StopError && /fn:config|fingerprint/.test((e as Error).message),
  );
  assert.equal(f.mutations().length, 0, "no mutation when the gate fails");
});

test("phaseActivate: REFUSES to run without prepared-state evidence even with matching fingerprints", async () => {
  const f = makeFakeGql();
  const io = makeIo({ readSecretFingerprints: MATCHING_FP });
  await assert.rejects(
    () => phaseActivate({ state: baseState(), gql: f.gql, io, log: silent }),
    (e) => e instanceof StopError && /--prepare/.test((e as Error).message),
  );
});

test("phaseActivate: with prepared evidence + matching fingerprints, creates ONE Cart Transform + ONE Validation, enforcement still OFF", async () => {
  const f = makeFakeGql({ shopPolicy: GOOD_SHOP(false), productPolicy: GOOD_PROD });
  const io = makeIo({ readSecretFingerprints: MATCHING_FP, receipt: { phaseReached: "prepared", resources: { adjustmentVariantId: ADJ_VARIANT } } });
  const res = await phaseActivate({ state: preparedState(), gql: f.gql, io, log: silent });
  assert.equal(f.transformCreated, true);
  assert.equal(f.validationCreated, true);
  const kinds = f.mutations().map((m) => (m.query.match(/(cartTransformCreate|validationCreate|metafieldsSet)/) || [])[1]);
  assert.deepEqual(kinds.filter(Boolean), ["cartTransformCreate", "validationCreate"], "no metafieldsSet — enforcement is untouched by --activate");
  assert.equal(res.receipt.phaseReached, "activated");
  assert.equal(res.receipt.resources.cartTransformId, "gid://shopify/CartTransform/OURS");
});

test("phaseActivate: idempotent — a rerun with resources already present creates nothing", async () => {
  const state = preparedState({
    cartTransforms: [{ id: "gid://shopify/CartTransform/OURS", functionId: TRANSFORM_FN, blockOnFailure: true }],
    validations: [{ id: "gid://shopify/Validation/OURS", title: "ImprintID Dynamic Pricing Validation", enabled: true, blockOnFailure: true }],
    receipt: { phaseReached: "activated", resources: { adjustmentVariantId: ADJ_VARIANT } },
  });
  const f = makeFakeGql({ shopPolicy: GOOD_SHOP(false), productPolicy: GOOD_PROD });
  const io = makeIo({ readSecretFingerprints: MATCHING_FP, receipt: { phaseReached: "activated" } });
  await phaseActivate({ state, gql: f.gql, io, log: silent });
  assert.equal(f.mutations().length, 0, "nothing to create on a converged rerun");
});

// --- enable-pilot ---------------------------------------------------------------

test("phaseEnablePilot: REFUSES to run before activation", async () => {
  const f = makeFakeGql({ shopPolicy: GOOD_SHOP(false), productPolicy: GOOD_PROD });
  const io = makeIo({ receipt: { phaseReached: "prepared" } });
  await assert.rejects(
    () => phaseEnablePilot({ state: preparedState(), gql: f.gql, io, log: silent }),
    (e) => e instanceof StopError && /--activate/.test((e as Error).message),
  );
  assert.equal(f.mutations().length, 0);
});

test("phaseEnablePilot: after activation, flips enabled → true (pilot mode; only metafieldsSet)", async () => {
  const activated = preparedState({
    cartTransforms: [{ id: "gid://shopify/CartTransform/OURS", functionId: TRANSFORM_FN, blockOnFailure: true }],
    validations: [{ id: "gid://shopify/Validation/OURS", title: "ImprintID Dynamic Pricing Validation", enabled: true, blockOnFailure: true }],
    receipt: { phaseReached: "activated", resources: { adjustmentVariantId: ADJ_VARIANT } },
  });
  const f = makeFakeGql({ shopPolicy: GOOD_SHOP(false), productPolicy: GOOD_PROD });
  const io = makeIo({ receipt: { phaseReached: "activated", resources: { adjustmentVariantId: ADJ_VARIANT } } });
  const res = await phaseEnablePilot({ state: activated, gql: f.gql, io, log: silent });
  const kinds = f.mutations().map((m) => (m.query.match(/(metafieldsSet|cartTransformCreate|validationCreate)/) || [])[1]).filter(Boolean);
  assert.deepEqual(kinds, ["metafieldsSet"]);
  const shop = parseShopEnforcementPolicy(f.store.shopPolicy);
  assert.equal(shop!.enabled, true);
  assert.equal(shop!.mode, "pilot");
  assert.equal(res.receipt.phaseReached, "pilot-enabled");
});

test("phaseEnablePilot: BLOCKED on a currency mismatch (USD profile / BDT shop) — no FX", async () => {
  const activated = preparedState({
    shopCurrency: "BDT",
    cartTransforms: [{ id: "gid://shopify/CartTransform/OURS", functionId: TRANSFORM_FN, blockOnFailure: true }],
    validations: [{ id: "gid://shopify/Validation/OURS", title: "ImprintID Dynamic Pricing Validation", enabled: true, blockOnFailure: true }],
    receipt: { phaseReached: "activated", resources: { adjustmentVariantId: ADJ_VARIANT } },
  });
  const f = makeFakeGql({ shopPolicy: GOOD_SHOP(false), productPolicy: GOOD_PROD });
  const io = makeIo({ receipt: { phaseReached: "activated" } });
  await assert.rejects(
    () => phaseEnablePilot({ state: activated, gql: f.gql, io, log: silent }),
    (e) => e instanceof StopError && /currency/.test((e as Error).message),
  );
});

// --- rollback-check -------------------------------------------------------------

test("Task 5B.3B.3: the CLI wires the mutation-phase session-lease guard BEFORE dispatching a phase", () => {
  const src = readFileSync(fileURLToPath(new URL("../../scripts/shopify/provision.mjs", import.meta.url)), "utf8");
  // the guard is computed from the connected session expiry + the selected phase
  assert.match(src, /leaseBlockers\(\s*sessionExpires\s*,\s*phase\s*\)/);
  // a non-empty result stops the run before any phase function is called
  const guardIdx = src.indexOf("leaseBlockers(");
  const runnerIdx = src.indexOf("await runner(ctx)");
  assert.ok(guardIdx > 0 && runnerIdx > guardIdx, "the lease check must precede runner(ctx)");
  assert.match(src.slice(guardIdx, runnerIdx), /throw new StopError/);
});

test("phaseRollbackCheck: executes NOTHING and prints an ordered plan for the receipt", async () => {
  const f = makeFakeGql();
  const io = makeIo();
  const lines: string[] = [];
  const state = baseState({
    receipt: {
      phaseReached: "activated",
      resources: { adjustmentProductId: ADJ_PRODUCT, cartTransformId: "gid://shopify/CartTransform/OURS", validationId: "gid://shopify/Validation/OURS" },
    },
  });
  const res = await phaseRollbackCheck({ state, gql: f.gql, io, log: (s: string) => lines.push(String(s)) });
  assert.equal(res.mutated, false);
  assert.equal(f.calls.length, 0, "rollback-check makes no Admin calls at all");
  assert.equal(res.plan.executed, false);
  assert.ok(/ROLLBACK PLAN \(NOT executed\)/.test(lines.join("\n")));
  assert.ok(/validationDelete/.test(lines.join("\n")));
});

void LNY01;
