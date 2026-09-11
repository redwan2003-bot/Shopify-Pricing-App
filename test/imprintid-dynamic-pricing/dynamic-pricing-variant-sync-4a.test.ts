/**
 * Task 4A — PRODUCT-ID PRICING RESOLUTION FOR BLANK-SKU VARIANTS (storefront side).
 * Genuine execution tests (real jsdom DOM, real `PricingBlock`, mocked `fetch`). The
 * mock server echoes a canonical `identity` (shopifyProductId / shopifyVariantId /
 * resolutionSource) built from each request's own ids — so quote-ownership and
 * stale-response handling are exercised end to end. No live network, no GraphiQL.
 *
 * No hard-coded color name and no real store id — every id/SKU is a synthetic fixture.
 * Blank SKUs (`""`) model LNY01's three real no-SKU variants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const PRODUCT_GID = "gid://shopify/Product/9442404663548";
const PRODUCT_ID = "9442404663548"; // bare decimal — deliberately > Number.MAX_SAFE_INTEGER shape
const HUGE_PRODUCT_ID = "99999999999999999999999";

const LOCALE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../extensions/imprintid-dynamic-pricing/locales/en.default.json", import.meta.url)),
    "utf8",
  ),
) as { dynamic_pricing: Record<string, string> };
const STRINGS: Record<string, string> = Object.fromEntries(
  Object.entries(LOCALE.dynamic_pricing).map(([k, v]) => ["dynamic_pricing." + k, v]),
);

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** Three blank-SKU variants — an LNY01-style multi-variant product with no SKUs. */
const BLANK_SKU_MAP = {
  "1001": { sku: "", available: true },
  "1002": { sku: "", available: true },
  "1003": { sku: "", available: true },
};

function catalogResponse(identity: Record<string, string> | null) {
  return {
    ok: true,
    data: {
      sku: "",
      identity,
      quantityTiers: [{ minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 }],
      productColors: [],
      decorationMethods: [],
      optionGroups: [],
      productionRules: [{ code: "STD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null }],
    },
  };
}

function calcResponse(identity: Record<string, string> | null, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      quantity: 100,
      quantityTier: { id: "t1", minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 },
      availableQuantityTiers: [],
      base: { quantity: 100, listUnitPriceCents: 229, netUnitPriceCents: 137, listSubtotalCents: 22900, netSubtotalCents: 13700 },
      productColor: null,
      decoration: null,
      options: { selections: [], chargesCents: 0 },
      production: { code: "STD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null },
      packaging: null,
      totals: { listTotalCents: 22900, netTotalCents: 13700 },
      cartPricing: { version: 1, payload: '{"v":1}', signature: "sig" },
      identity,
      ...overrides,
    },
  };
}

function pricingRootHtml(attrs: Record<string, string>) {
  const attrString = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v.replace(/"/g, "&quot;")}"`)
    .join(" ");
  return `
    <div data-imprintid-pricing-test-root ${attrString}>
      <p data-imprintid-pricing-unavailable hidden></p>
      <p data-imprintid-pricing-loading hidden></p>
      <div data-imprintid-pricing-panel hidden>
        <form data-imprintid-pricing-form novalidate>
          <input type="number" data-imprintid-pricing-quantity min="1" step="1">
          <p data-imprintid-pricing-quantity-error hidden></p>
          <div data-imprintid-pricing-color-wrap hidden><select data-imprintid-pricing-color></select></div>
          <fieldset data-imprintid-pricing-decoration-fieldset>
            <select data-imprintid-pricing-colors><option value="1">1</option><option value="2">2</option></select>
            <select data-imprintid-pricing-locations><option value="1">1</option><option value="2">2</option></select>
            <input type="checkbox" data-imprintid-pricing-reverse-side>
            <div data-imprintid-pricing-reverse-artwork-wrap hidden><input type="checkbox" data-imprintid-pricing-reverse-artwork></div>
            <input type="checkbox" data-imprintid-pricing-repeat-order>
          </fieldset>
          <div data-imprintid-pricing-options></div>
          <select data-imprintid-pricing-production></select>
          <p data-imprintid-pricing-production-hint></p>
        </form>
        <div data-imprintid-pricing-result>
          <span data-imprintid-pricing-list-unit></span><span data-imprintid-pricing-net-unit></span><span data-imprintid-pricing-total></span>
          <p data-imprintid-pricing-tier-note></p>
          <table data-imprintid-pricing-tier-table hidden><tbody data-imprintid-pricing-tier-table-body></tbody></table>
          <details data-imprintid-pricing-breakdown><dl data-imprintid-pricing-breakdown-list></dl></details>
        </div>
        <p data-imprintid-pricing-error hidden></p>
        <div data-imprintid-pricing-actions>
          <button type="button" data-imprintid-pricing-add-to-cart disabled></button>
          <p data-imprintid-pricing-add-to-cart-status></p>
        </div>
      </div>
    </div>`;
}

interface SetupOptions {
  fetchHandler?: (call: FetchCall) => unknown;
  variantMap?: Record<string, { sku: string; available: boolean }>;
  omitVariantMap?: boolean;
  rawVariantMap?: string;
  shopifyProductId?: string | null; // null omits data-shopify-product-id
  variantId?: string;
  variantSku?: string;
  sectionId?: string | null;
}

/** Default handler: echoes an `identity` derived from the request's own product/variant
 * ids (GET from URL params, POST from the body), so the block's quote-ownership checks
 * see a matching response. */
function defaultHandler(call: FetchCall) {
  if (call.method === "GET") {
    const u = new URL(call.url, "https://example.test");
    const pid = u.searchParams.get("shopifyProductId");
    const vid = u.searchParams.get("shopifyVariantId");
    return catalogResponse(pid && vid ? { shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "product_override" } : null);
  }
  const pid = call.body && typeof call.body.shopifyProductId === "string" ? call.body.shopifyProductId : null;
  const vid = call.body && typeof call.body.shopifyVariantId === "string" ? call.body.shopifyVariantId : null;
  return calcResponse(pid && vid ? { shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "product_override" } : null);
}

/**
 * The previous test's `PricingBlock` + jsdom window. `dynamic-pricing.js` calls the
 * GLOBAL `fetch` / `window` (never a captured reference), so a debounce/probe timer left
 * pending by a prior test would, under heavy parallel load, fire after the next
 * `setupPricingBlock` has reassigned `globalThis.fetch` and push a stray call into the
 * new test's `fetchCalls`. Tearing the prior instance down here makes every test
 * deterministic regardless of machine load.
 */
let previousInstance: { dom: JSDOM; block: Record<string, unknown> } | null = null;

function teardownPrevious() {
  if (!previousInstance) return;
  try {
    (previousInstance.block as { destroy?: () => void }).destroy?.();
  } catch {
    /* ignore */
  }
  try {
    previousInstance.dom.window.close(); // cancels this window's pending timers
  } catch {
    /* ignore */
  }
  previousInstance = null;
}

async function setupPricingBlock(options: SetupOptions) {
  teardownPrevious();
  const sectionId = options.sectionId === undefined ? "sec1" : options.sectionId;
  const handler = options.fetchHandler ?? defaultHandler;

  const rootAttrs: Record<string, string> = {
    "data-sku": options.variantSku ?? "",
    "data-variant-id": options.variantId ?? "1001",
    "data-variant-sku": options.variantSku ?? "",
    "data-variant-available": "true",
    "data-product-gid": PRODUCT_GID,
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };
  if (options.shopifyProductId !== null) {
    rootAttrs["data-shopify-product-id"] = options.shopifyProductId ?? PRODUCT_ID;
  }
  if (!options.omitVariantMap) {
    rootAttrs["data-variant-map"] =
      options.rawVariantMap !== undefined ? options.rawVariantMap : JSON.stringify(options.variantMap ?? BLANK_SKU_MAP);
  }
  if (sectionId !== null) rootAttrs["data-section-id"] = sectionId;

  const sectionOpen = sectionId !== null ? `<div data-section-id="${sectionId}" id="shopify-section-${sectionId}">` : `<div>`;
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>${sectionOpen}${pricingRootHtml(rootAttrs)}</div></body></html>`,
    { url: "https://example-shop.myshopify.com/products/lny01", runScripts: "outside-only" },
  );

  (globalThis as unknown as { window: typeof dom.window }).window = dom.window;
  globalThis.document = dom.window.document as unknown as Document;
  (dom.window as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };
  (globalThis as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };

  const fetchCalls: FetchCall[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method as string) || "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    const call: FetchCall = { url, method, body };
    fetchCalls.push(call);
    return { ok: true, status: 200, json: async () => handler(call) } as Response;
  }) as typeof fetch;
  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = dom.window.AbortController;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = dom.window.CustomEvent;

  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);

  const root = dom.window.document.querySelector("[data-imprintid-pricing-test-root]")!;
  root.removeAttribute("data-imprintid-pricing-test-root");
  root.setAttribute("data-imprintid-pricing", "");
  const ImprintIdPricing = (dom.window as unknown as { ImprintIdPricing: { PricingBlock: new (root: Element) => unknown } }).ImprintIdPricing;
  const block = new ImprintIdPricing.PricingBlock(root) as Record<string, unknown>;
  previousInstance = { dom, block };
  return { dom, root, block, fetchCalls, sectionId };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function btn(root: Element) {
  return root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
}
function dispatchProductSelect(dom: JSDOM, target: EventTarget, opts: { productId: string; promise: Promise<unknown> }) {
  const EventCtor = dom.window as unknown as { CustomEvent: typeof CustomEvent };
  const event = new EventCtor.CustomEvent("shopify:product:select", { bubbles: true }) as CustomEvent & {
    product: { id: string };
    selectedOptions: Record<string, string>;
    promise: Promise<unknown>;
  };
  event.product = { id: opts.productId };
  event.selectedOptions = { "Some Option": "some-value" };
  event.promise = opts.promise;
  target.dispatchEvent(event);
}
const posts = (calls: FetchCall[]) => calls.filter((c) => c.method === "POST" && c.url.includes("pricing"));
const gets = (calls: FetchCall[]) => calls.filter((c) => c.method === "GET");

// ============================================================================

test("1: LNY01-style multi-variant metadata with three blank SKUs is valid + priceable when a product id is present", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({});
  await wait(60);

  assert.equal((block as { variantMetadataValid: boolean }).variantMetadataValid, true);
  assert.equal((block as { validatedVariantCount: number }).validatedVariantCount, 3);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), true);
  assert.ok(gets(fetchCalls).length >= 1, "catalog loaded");
  assert.ok(posts(fetchCalls).length >= 1, "pricing requested");
  assert.equal(btn(root).disabled, false, "Add to Cart enables once the blank-SKU quote lands");
});

test("2: Black/Red/Blue-style variant switching works with no hard-coded option names (blank SKUs, product id constant)", async () => {
  const { dom, block, fetchCalls, sectionId } = await setupPricingBlock({});
  await wait(60);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(400);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  const last = posts(fetchCalls).slice(-1)[0]!;
  assert.equal(last.body!.shopifyProductId, PRODUCT_ID, "same product id");
  assert.equal(last.body!.shopifyVariantId, "1002", "new variant id");
});

test("3 + 4: product and variant ids are carried as strings, unchanged, even beyond Number.MAX_SAFE_INTEGER", async () => {
  const { block, fetchCalls } = await setupPricingBlock({ shopifyProductId: HUGE_PRODUCT_ID });
  await wait(60);
  assert.equal((block as { shopifyProductId: string }).shopifyProductId, HUGE_PRODUCT_ID);
  assert.equal(typeof (block as { shopifyProductId: unknown }).shopifyProductId, "string");
  const post = posts(fetchCalls).slice(-1)[0]!;
  assert.equal(post.body!.shopifyProductId, HUGE_PRODUCT_ID);
  assert.equal(typeof post.body!.shopifyProductId, "string");
  const get = gets(fetchCalls)[0]!;
  assert.ok(get.url.includes("shopifyProductId=" + HUGE_PRODUCT_ID));
});

test("5: a blank-SKU variant with NO product id fails closed — no catalog, no pricing request", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({ shopifyProductId: null });
  await wait(60);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
});

test("6: malformed variant metadata (a null SKU in the map) fails closed even with a product id", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    rawVariantMap: '{"1001":{"sku":null,"available":true}}',
  });
  await wait(60);
  assert.equal((block as { variantMetadataValid: boolean }).variantMetadataValid, false);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.filter((c) => !c.url.includes("policyOnly")).length, 0, "no catalog / pricing request");
  assert.equal(btn(root).disabled, true);
});

test("17: a variant switch clears the old quote and re-requests with the new variant id (same product id)", async () => {
  const { dom, root, block, fetchCalls, sectionId } = await setupPricingBlock({});
  await wait(60);
  assert.equal(btn(root).disabled, false, "quoted for 1001");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1001");

  let resolve2!: () => void;
  const gate = new Promise<void>((r) => (resolve2 = r));
  // Make the NEW variant's quote hang so we can observe the cleared/disabled interim state.
  const { fetchCalls: _c } = { fetchCalls };
  void _c;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method as string) || "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    fetchCalls.push({ url, method, body });
    if (method === "POST" && body && body.shopifyVariantId === "1002") {
      await gate;
    }
    return { ok: true, status: 200, json: async () => defaultHandler({ url, method, body }) } as Response;
  }) as typeof fetch;

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(80);

  assert.equal((block as { quotedVariantId: unknown }).quotedVariantId, null, "old quote cleared");
  assert.equal((block as { quotedProductId: unknown }).quotedProductId, null);
  assert.equal(btn(root).disabled, true, "disabled while the new quote is in flight");

  resolve2();
  await wait(60);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1002");
  const last = posts(fetchCalls).slice(-1)[0]!;
  assert.equal(last.body!.shopifyProductId, PRODUCT_ID);
  assert.equal(last.body!.shopifyVariantId, "1002");
});

test("18: a stale pricing response for a different variant is ignored (identity mismatch)", async () => {
  const { dom, block, fetchCalls, sectionId } = await setupPricingBlock({
    variantMap: { "1001": { sku: "", available: true }, "1002": { sku: "", available: true } },
    fetchHandler: (call) => {
      if (call.method === "GET") {
        const u = new URL(call.url, "https://x.test");
        return catalogResponse({
          shopifyProductId: u.searchParams.get("shopifyProductId")!,
          shopifyVariantId: u.searchParams.get("shopifyVariantId")!,
          resolutionSource: "product_override",
        });
      }
      // Every POST answers with identity for variant 1001 — deliberately stale once the
      // block has moved on to 1002.
      return calcResponse({ shopifyProductId: PRODUCT_ID, shopifyVariantId: "1001", resolutionSource: "product_override" });
    },
  });
  await wait(60);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(400);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  // The stale (identity=1001) response must NOT have been adopted as a quote for 1002.
  assert.equal((block as { quotedVariantId: unknown }).quotedVariantId, null);
  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0);
});

test("19: a direct programmatic addToCart() cannot bypass product/variant quote ownership", async () => {
  const { block, fetchCalls } = await setupPricingBlock({});
  await wait(60);
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1001");

  // Desync the selection out from under the quote, then call addToCart() directly.
  (block as { selectedVariantId: string }).selectedVariantId = "1002";
  (block as { addToCart: () => void }).addToCart();
  await wait(40);
  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0, "no cart write on a variant mismatch");

  // Also desync the product id.
  (block as { selectedVariantId: string }).selectedVariantId = "1001";
  (block as { quotedProductId: string }).quotedProductId = "8888888888";
  (block as { addToCart: () => void }).addToCart();
  await wait(40);
  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0, "no cart write on a product mismatch");
});

test("20: Task 2B.2 — a multi-variant blank-SKU product with no resolvable section still fails closed", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({ sectionId: null });
  await wait(60);
  assert.equal((block as { variantSynchronizationRequired: boolean }).variantSynchronizationRequired, true);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.filter((c) => !c.url.includes("policyOnly")).length, 0, "no catalog / pricing request");
  assert.equal(btn(root).disabled, true);
});

test("21: Task 2B.3 — a missing variant-map still fails closed even with a valid product id", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({ omitVariantMap: true });
  await wait(60);
  assert.equal((block as { variantMetadataValid: boolean }).variantMetadataValid, false);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.filter((c) => !c.url.includes("policyOnly")).length, 0, "no catalog / pricing request");
  assert.equal(btn(root).disabled, true);
});

test("a non-blank SKU with no product id still works (unchanged legacy path)", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    shopifyProductId: null,
    variantMap: { "1001": { sku: "REAL-A", available: true } },
    variantId: "1001",
    variantSku: "REAL-A",
    fetchHandler: (call) => (call.method === "GET" ? catalogResponse(null) : calcResponse(null)),
  });
  await wait(60);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), true);
  assert.ok(gets(fetchCalls)[0]!.url.includes("sku=REAL-A"));
  assert.equal(btn(root).disabled, false);
});
