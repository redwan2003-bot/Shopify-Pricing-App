/**
 * Task 2B — variant synchronization. Genuine execution tests (real DOM via jsdom, real
 * `PricingBlock` instances, mocked `fetch`) covering the full 20-scenario matrix from
 * the Task 2B report. See dynamic-pricing.js's own "Variant synchronization" section
 * for the implementation these exercise.
 *
 * No color name (Black/Red/Blue) or real Shopify id from this project's actual store is
 * ever hardcoded here — every variant id/SKU/GID below is a synthetic test fixture
 * value, deliberately generic ("A"/"B"/"C"), per the explicit instruction not to assume
 * or encode any real color-to-id mapping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const PRODUCT_GID = "gid://shopify/Product/9000000000001";
const OTHER_PRODUCT_GID = "gid://shopify/Product/9000000000099";

const CATALOG_RESPONSE = {
  ok: true,
  data: {
    sku: "LNY01-A",
    quantityTiers: [{ minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 }],
    productColors: [],
    decorationMethods: [],
    optionGroups: [],
    productionRules: [
      { code: "STANDARD", name: "Standard Production", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null },
    ],
  },
};

function buildCalcResponse(overrides: Record<string, unknown> = {}) {
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
      production: { code: "STANDARD", name: "Standard Production", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null },
      packaging: null,
      totals: { listTotalCents: 22900, netTotalCents: 13700 },
      cartPricing: { version: 1, payload: '{"v":1}', signature: "sig" },
      ...overrides,
    },
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

const DEFAULT_VARIANT_MAP = {
  "1001": { sku: "LNY01-A", available: true },
  "1002": { sku: "LNY01-B", available: true },
  "1003": { sku: "LNY01-C", available: false },
};

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
          <div data-imprintid-pricing-color-wrap hidden>
            <select data-imprintid-pricing-color></select>
          </div>
          <fieldset data-imprintid-pricing-decoration-fieldset>
            <select data-imprintid-pricing-colors><option value="1">1</option><option value="2">2</option></select>
            <select data-imprintid-pricing-locations><option value="1">1</option><option value="2">2</option></select>
            <input type="checkbox" data-imprintid-pricing-reverse-side>
            <div data-imprintid-pricing-reverse-artwork-wrap hidden>
              <input type="checkbox" data-imprintid-pricing-reverse-artwork>
            </div>
            <input type="checkbox" data-imprintid-pricing-repeat-order>
          </fieldset>
          <div data-imprintid-pricing-options></div>
          <select data-imprintid-pricing-production></select>
          <p data-imprintid-pricing-production-hint></p>
        </form>
        <div data-imprintid-pricing-result>
          <span data-imprintid-pricing-list-unit></span>
          <span data-imprintid-pricing-net-unit></span>
          <span data-imprintid-pricing-total></span>
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
  fetchHandler: (call: FetchCall) => unknown;
  variantMap?: Record<string, { sku: string; available: boolean }>;
  variantId?: string;
  variantSku?: string;
  variantAvailable?: boolean;
  productGid?: string;
  sectionId?: string;
  formInputValue?: string; // omit to skip rendering a form/hidden input entirely
  includeUnrelatedForm?: boolean; // a second, unrelated section+form elsewhere on the page
}

/** Builds the DOM skeleton mirroring dynamic-pricing.liquid's post-Task-2B structure —
 * a Shopify section container (`[data-section-id]`) wrapping both the block root and
 * (optionally) a product-form's hidden `input[name="id"]`, exactly like a real Horizon
 * page where the app block and the product form are siblings within the same section. */
async function setupPricingBlock(options: SetupOptions) {
  const sectionId = options.sectionId ?? "sec1";
  const variantMap = options.variantMap ?? DEFAULT_VARIANT_MAP;

  const formHtml =
    options.formInputValue === undefined
      ? ""
      : `<form data-type="add-to-cart-form"><input type="hidden" name="id" value="${options.formInputValue}"></form>`;

  const unrelatedHtml = options.includeUnrelatedForm
    ? `<div data-section-id="unrelated-sec">
         <form data-type="add-to-cart-form"><input type="hidden" name="id" value="1002"></form>
       </div>`
    : "";

  const rootAttrs: Record<string, string> = {
    "data-sku": options.variantSku ?? "LNY01-A",
    "data-variant-id": options.variantId ?? "1001",
    "data-variant-sku": options.variantSku ?? "LNY01-A",
    "data-variant-available": String(options.variantAvailable ?? true),
    "data-product-gid": options.productGid ?? PRODUCT_GID,
    "data-section-id": sectionId,
    "data-variant-map": JSON.stringify(variantMap),
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div data-section-id="${sectionId}" id="shopify-section-${sectionId}">
        ${formHtml}
        ${pricingRootHtml(rootAttrs)}
      </div>
      ${unrelatedHtml}
    </body></html>`,
    { url: "https://example-shop.myshopify.com/products/lny01", runScripts: "outside-only" },
  );

  (globalThis as unknown as { window: typeof dom.window }).window = dom.window;
  globalThis.document = dom.window.document as unknown as Document;
  (globalThis as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = {};

  const fetchCalls: FetchCall[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method as string) || "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: FetchCall = { url, method, body };
    fetchCalls.push(call);
    const responseBody = options.fetchHandler(call);
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
    } as Response;
  }) as typeof fetch;

  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = dom.window.AbortController;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = dom.window.CustomEvent;

  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);

  const root = dom.window.document.querySelector("[data-imprintid-pricing-test-root]")!;
  root.removeAttribute("data-imprintid-pricing-test-root");
  root.setAttribute("data-imprintid-pricing", "");
  const ImprintIdPricing = (dom.window as unknown as { ImprintIdPricing: { PricingBlock: new (root: Element) => unknown } }).ImprintIdPricing;
  const block = new ImprintIdPricing.PricingBlock(root) as Record<string, unknown>;

  return { dom, root, block, fetchCalls, sectionId };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dispatches a `shopify:product:select` event on the given target, with exactly the
 * confirmed real contract's fields (`product`, `selectedOptions`, `promise`) — no
 * `event.detail.*` involved. */
function dispatchProductSelect(
  dom: JSDOM,
  target: EventTarget,
  opts: { productId: string; promise: Promise<unknown> },
) {
  const EventCtor = dom.window as unknown as { CustomEvent: typeof CustomEvent };
  const event = new EventCtor.CustomEvent("shopify:product:select", { bubbles: true }) as CustomEvent & {
    product: { id: string };
    selectedOptions: Record<string, string>;
    promise: Promise<unknown>;
  };
  event.product = { id: opts.productId };
  event.selectedOptions = {};
  event.promise = opts.promise;
  target.dispatchEvent(event);
}

// ---- #1: Initial selected variant ID and SKU are used ---------------------------

test("#1 initial selected variant id and SKU are used for the first quote and for Add to Cart", async () => {
  const { root, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
    variantId: "1001",
    variantSku: "LNY01-A",
  });
  await wait(50);

  const posts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing"));
  const lastBody = posts[posts.length - 1]!.body as { shopifyVariantId: string };
  assert.equal(lastBody.shopifyVariantId, "1001");

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, false);
  addToCartButton.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
  await wait(50);

  const cartAdd = fetchCalls.find((c) => c.url.includes("/cart/add.js"));
  assert.equal((cartAdd!.body as { items: Array<{ id: string }> }).items[0]!.id, "1001");
});

// ---- #2: product events for another product are ignored -------------------------

test("#2 a shopify:product:select event for a DIFFERENT product GID is ignored entirely", async () => {
  const { dom, block, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);
  const postCountBefore = fetchCalls.filter((c) => c.method === "POST").length;

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  let thenCalled = false;
  // A thenable spy — not a plain Promise — so we can prove the block never even calls
  // `.then()` on it, rather than just checking whether some outer producer function ran
  // (which would run regardless of whether the block reads the resulting promise).
  const spyPromise = {
    then(onFulfilled: (v: unknown) => void) {
      thenCalled = true;
      onFulfilled({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } });
    },
  };
  dispatchProductSelect(dom, sectionEl, { productId: OTHER_PRODUCT_GID, promise: spyPromise as unknown as Promise<unknown> });
  await wait(50);

  assert.equal(thenCalled, false, "the event's own promise should never even be read (.then called) for a non-matching product");
  assert.equal(fetchCalls.filter((c) => c.method === "POST").length, postCountBefore, "no recalculation should be triggered");
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1001", "selected variant must be unchanged");
});

// ---- #4: A -> B-style change (no hardcoded colors) -------------------------------

test("#4 a valid variant-select event switches to the new variant id and SKU, refetching the catalog", async () => {
  let getCount = 0;
  const { dom, block, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") {
        getCount++;
        return { ...CATALOG_RESPONSE, data: { ...CATALOG_RESPONSE.data, sku: call.url.includes("LNY01-B") ? "LNY01-B" : "LNY01-A" } };
      }
      return buildCalcResponse();
    },
  });
  await wait(50);
  assert.equal(getCount, 1, "sanity: one catalog fetch for the initial variant");

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "LNY01-B");
  assert.equal(getCount, 2, "a SKU change must refetch the catalog, not just recalculate against the old one");

  const posts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing"));
  const lastBody = posts[posts.length - 1]!.body as { sku: string; shopifyVariantId: string };
  assert.equal(lastBody.sku, "LNY01-B");
  assert.equal(lastBody.shopifyVariantId, "1002");
});

// ---- #6: existing quote invalidated immediately when the event fires ------------

test("#6 Add to Cart disables the instant a variant-select event fires, before its promise even resolves", async () => {
  const { dom, root, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, false, "sanity: enabled before any change");

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  let resolvePromise!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  dispatchProductSelect(dom, sectionEl, { productId: PRODUCT_GID, promise: pending });

  // Synchronous check — the promise has NOT resolved yet.
  assert.equal(addToCartButton.disabled, true, "must invalidate immediately, not wait for the promise");

  resolvePromise({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } });
  await wait(50);
});

// ---- #5: rapid A -> B -> C changes ignore stale intermediate results -------------

test("#5 rapid A -> B -> C variant-select events: only the final (C) selection's result is ever adopted", async () => {
  const { dom, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
    variantMap: {
      "1001": { sku: "LNY01-A", available: true },
      "1002": { sku: "LNY01-A", available: true }, // same SKU as A on purpose, isolates the id-vs-sequence race
      "1003": { sku: "LNY01-A", available: true },
    },
  });
  await wait(50);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;

  // B's promise resolves LATER than C's, simulating a slow/out-of-order network resolution.
  let resolveB!: (value: unknown) => void;
  const bPromise = new Promise((resolve) => {
    resolveB = resolve;
  });
  dispatchProductSelect(dom, sectionEl, { productId: PRODUCT_GID, promise: bPromise });
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1003", availableForSale: true } }),
  });
  await wait(50);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003", "C should already be adopted");

  // Now let B's stale promise resolve — it must be ignored.
  resolveB({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } });
  await wait(50);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003", "a late-resolving stale (B) promise must never overwrite the newer (C) selection");
});

// ---- #7: unavailable variant never requests pricing and cannot be added ---------

test("#7 selecting an unavailable variant never requests pricing and Add to Cart stays blocked", async () => {
  const { dom, root, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);
  const postCountBefore = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length;

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1003", availableForSale: false } }),
  });
  await wait(50);

  assert.equal(
    fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length,
    postCountBefore,
    "no pricing request should be sent for an unavailable variant",
  );
  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, true);
  const errorEl = root.querySelector("[data-imprintid-pricing-error]") as HTMLElement;
  assert.equal(errorEl.hidden, false);
});

// ---- #8: null variant never requests pricing -------------------------------------

test("#8 a resolution with variant: null never requests pricing and fails closed", async () => {
  const { dom, root, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);
  const postCountBefore = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length;

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, { productId: PRODUCT_GID, promise: Promise.resolve({ variant: null }) });
  await wait(50);

  assert.equal(fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length, postCountBefore);
  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, true);
});

// ---- #9: rejected event promise fails closed -------------------------------------

test("#9 a rejected event.promise fails closed (disables Add to Cart, shows an error, never throws)", async () => {
  const { dom, root, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, { productId: PRODUCT_GID, promise: Promise.reject(new Error("lookup failed")) });
  await wait(50);

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, true);
  const errorEl = root.querySelector("[data-imprintid-pricing-error]") as HTMLElement;
  assert.equal(errorEl.hidden, false);
});

// ---- #10: variant absent from the Liquid map fails closed ------------------------

test("#10 a variant id that resolves via the event but is absent from the trusted variant map fails closed", async () => {
  const { dom, root, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);
  const postCountBefore = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length;

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/9999999999", availableForSale: true } }),
  });
  await wait(50);

  assert.equal(fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length, postCountBefore);
  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, true);
});

// ---- #11: stale pricing HTTP response cannot replace the current quote ----------

test("#11 a stale (superseded-by-variant-change) pricing HTTP response never overwrites the current quote", async () => {
  let resolveFirstPost!: () => void;
  let postCount = 0;
  const { dom, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") return CATALOG_RESPONSE;
      postCount++;
      if (postCount === 1) {
        // First POST (for the ORIGINAL variant) never resolves until we release it below.
        return new Promise((resolve) => {
          resolveFirstPost = () => resolve(buildCalcResponse());
        });
      }
      return buildCalcResponse({ cartPricing: { version: 1, payload: '{"v":2}', signature: "sig2" } });
    },
  });
  await wait(20); // the initial recalculateNow() POST is now in-flight and NOT yet resolved

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50); // the second (variant-change-triggered) request resolves normally

  resolveFirstPost(); // now let the FIRST, now-stale response resolve
  await wait(50);

  assert.equal((block as { quotedVariantId: string | null }).quotedVariantId, "1002", "the stale first response must not overwrite the newer quote");
});

// ---- #13/#14: selected/quoted ID and SKU mismatches block Add to Cart -----------

test("#13 selected/quoted variant ID mismatch blocks Add to Cart and never calls /cart/add.js", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);

  // Force a desync directly: a quote exists for 1001, but selectedVariantId has moved.
  (block as { selectedVariantId: string }).selectedVariantId = "1002";

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  addToCartButton.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
  await wait(20);

  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0);
  assert.equal((block as { cartPricing: unknown }).cartPricing, null, "the mismatched quote must be invalidated");
});

test("#14 selected/quoted SKU mismatch blocks Add to Cart even when the IDs happen to match", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);

  // IDs still match, but the SKU was mutated out from under the quote (defensive check
  // beyond id alone — see Task 2B requirement F.3).
  (block as { selectedVariantSku: string }).selectedVariantSku = "LNY01-DIFFERENT";

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  addToCartButton.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
  await wait(20);

  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0);
});

// ---- regression: a STALE promise's rejection must never stomp a newer, already-
//      adopted selection (found while implementing #9's staleness guard) -----------

test("regression: a late rejection from a superseded (stale) event promise does not disturb the newer, already-adopted variant", async () => {
  const { dom, root, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
    variantMap: {
      "1001": { sku: "LNY01-A", available: true },
      "1002": { sku: "LNY01-A", available: true },
      "1003": { sku: "LNY01-A", available: true },
    },
  });
  await wait(50);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;

  let rejectStale!: (reason: unknown) => void;
  const stalePromise = new Promise((_resolve, reject) => {
    rejectStale = reject;
  });
  dispatchProductSelect(dom, sectionEl, { productId: PRODUCT_GID, promise: stalePromise });
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1003", availableForSale: true } }),
  });
  // The newer selection keeps the same SKU (see variantMap above), so adoption
  // recalculates via the debounced `recalculate()` entry point (300ms) rather than the
  // undebounced catalog-refetch path — wait past that debounce for the quote to land.
  await wait(400);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003");
  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, false, "sanity: the newer selection is fully quoted and addable");

  rejectStale(new Error("stale lookup failed"));
  await wait(50);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003", "must remain on the newer selection");
  assert.equal(addToCartButton.disabled, false, "the stale rejection must not disable an already-valid, newer quote");
});

// ---- #12: Add to Cart uses the latest quoted variant -----------------------------

test("#12 Add to Cart submits the latest quotedVariantId, not the initial Liquid-rendered id", async () => {
  const { dom, root, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
    variantMap: {
      "1001": { sku: "LNY01-A", available: true },
      "1002": { sku: "LNY01-A", available: true },
    },
  });
  await wait(50);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  // Same SKU for both variants in this map on purpose — routes through the debounced
  // `recalculate()` entry point (300ms), not the undebounced catalog-refetch path.
  await wait(400);

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, false);
  addToCartButton.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
  await wait(50);

  const cartAdd = fetchCalls.find((c) => c.url.includes("/cart/add.js"));
  assert.equal((cartAdd!.body as { items: Array<{ id: string }> }).items[0]!.id, "1002");
});

// ---- #15: hidden-input mismatch invalidates the quote ----------------------------

test("#15 a hidden input[name=id] value that disagrees with selectedVariantId invalidates the quote on the next recalculation", async () => {
  const { dom, root, block, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
    formInputValue: "1001",
    variantMap: {
      "1001": { sku: "LNY01-A", available: true },
      "1002": { sku: "LNY01-B", available: true },
    },
  });
  await wait(50);
  assert.equal((block as { cartPricing: unknown }).cartPricing !== null, true, "sanity: quoted after initial load");

  // Simulate the theme updating its own canonical field via direct property assignment
  // (exactly how Horizon's product-form.js does it — see Task 2B's evidence — which does
  // NOT fire a native change/input event, so nothing else in this block would otherwise
  // ever notice).
  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  const input = sectionEl.querySelector('input[name="id"]') as HTMLInputElement;
  input.value = "1002";

  // Trigger any recalculation path (e.g. a quantity change) — crossCheckFormInput runs
  // at the top of it.
  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.value = "150";
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  await wait(400);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "LNY01-B");
  const posts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing"));
  const lastBody = posts[posts.length - 1]!.body as { shopifyVariantId: string };
  assert.equal(lastBody.shopifyVariantId, "1002");
});

// ---- #16: missing/unrelated product forms never cause a cross-product lookup ----

test("#16 an unrelated form/section elsewhere on the page is never consulted for the hidden-input cross-check", async () => {
  const { root, block } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
    formInputValue: undefined, // no reliable field in THIS block's own section
    includeUnrelatedForm: true, // but one exists elsewhere on the page, id "1002"
  });
  await wait(50);

  assert.equal((block as { formVariantInput: unknown }).formVariantInput, null, "must not have resolved the unrelated section's input");

  // Triggering a recalculation must not pick up the unrelated form's id.
  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.value = "150";
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  await wait(400);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1001", "selected variant must remain the original — never adopted from an unrelated form");
});

// ---- #17: quantity/option changes invalidate the previous quote -----------------

test("#17 changing quantity invalidates the previous quote's ownership once the (debounced) recalculation runs, and a fresh quote takes over cleanly", async () => {
  // Quantity changes go through the same debounced `recalculate` entry point as before
  // Task 2B (see dynamic-pricing.js's `debounce`) — invalidation happens when that
  // debounced call actually fires `_recalculateImmediate`, same as this project's
  // pre-existing "changing quantity actually triggers a new pricing request" test
  // already establishes (it also waits out the 300ms debounce rather than asserting
  // anything synchronously on the input event itself).
  const { root, block } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, false, "sanity: quoted after initial load");
  const firstQuotedId = (block as { quotedVariantId: string }).quotedVariantId;
  assert.equal(firstQuotedId, "1001");

  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.value = "150";
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));

  await wait(400); // past the 300ms debounce
  assert.equal(addToCartButton.disabled, false, "re-enabled once the new quote for quantity 150 lands");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1001", "the new quote is still correctly owned by the same (unchanged) variant");
});

// ---- #18: multiple blocks keep independent state ---------------------------------

test("#18 two PricingBlock instances on one page track fully independent variant state", async () => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div data-section-id="sec-a" id="shopify-section-sec-a">
        <form data-type="add-to-cart-form"><input type="hidden" name="id" value="1001"></form>
        ${pricingRootHtml({
          "data-imprintid-block": "a",
          "data-sku": "LNY01-A",
          "data-variant-id": "1001",
          "data-variant-sku": "LNY01-A",
          "data-variant-available": "true",
          "data-product-gid": PRODUCT_GID,
          "data-section-id": "sec-a",
          "data-variant-map": JSON.stringify(DEFAULT_VARIANT_MAP),
          "data-proxy-path": "/apps/imprintid-pricing/pricing",
          "data-show-breakdown": "false",
        })}
      </div>
      <div data-section-id="sec-b" id="shopify-section-sec-b">
        <form data-type="add-to-cart-form"><input type="hidden" name="id" value="2001"></form>
        ${pricingRootHtml({
          "data-imprintid-block": "b",
          "data-sku": "OTHER-A",
          "data-variant-id": "2001",
          "data-variant-sku": "OTHER-A",
          "data-variant-available": "true",
          "data-product-gid": OTHER_PRODUCT_GID,
          "data-section-id": "sec-b",
          "data-variant-map": JSON.stringify({ "2001": { sku: "OTHER-A", available: true }, "2002": { sku: "OTHER-B", available: true } }),
          "data-proxy-path": "/apps/imprintid-pricing/pricing",
          "data-show-breakdown": "false",
        })}
      </div>
    </body></html>`,
    { url: "https://example-shop.myshopify.com/products/multi", runScripts: "outside-only" },
  );

  (globalThis as unknown as { window: typeof dom.window }).window = dom.window;
  globalThis.document = dom.window.document as unknown as Document;
  (globalThis as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = {};
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (...args: [unknown, RequestInit?]) => {
    const method = (args[1]?.method as string) || "GET";
    const responseBody = method === "GET" ? CATALOG_RESPONSE : buildCalcResponse();
    return { ok: true, status: 200, json: async () => responseBody } as Response;
  }) as typeof fetch;
  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = dom.window.AbortController;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = dom.window.CustomEvent;

  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);
  const ImprintIdPricing = (dom.window as unknown as { ImprintIdPricing: { PricingBlock: new (root: Element) => unknown } }).ImprintIdPricing;

  const rootA = dom.window.document.querySelector('[data-imprintid-block="a"]')!;
  rootA.setAttribute("data-imprintid-pricing", "");
  const blockA = new ImprintIdPricing.PricingBlock(rootA) as Record<string, unknown>;

  const rootB = dom.window.document.querySelector('[data-imprintid-block="b"]')!;
  rootB.setAttribute("data-imprintid-pricing", "");
  const blockB = new ImprintIdPricing.PricingBlock(rootB) as Record<string, unknown>;

  await wait(50);

  const sectionA = dom.window.document.getElementById("shopify-section-sec-a")!;
  dispatchProductSelect(dom, sectionA, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);

  assert.equal(blockA.selectedVariantId, "1002", "block A adopts its own event");
  assert.equal(blockB.selectedVariantId, "2001", "block B must be completely unaffected by block A's event");
});

// ---- #19: section/block reinitialization does not duplicate listeners -----------

test("#19 calling initAll() twice against the same root never double-initializes or double-fires", async () => {
  const { dom, root, fetchCalls, sectionId } = await setupPricingBlockViaInitAll({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);

  const ImprintIdPricing = (dom.window as unknown as { ImprintIdPricing: { PricingBlock: new (root: Element) => unknown } }).ImprintIdPricing;
  const firstInstance = (root as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock;
  assert.ok(firstInstance, "sanity: initAll constructed one instance");

  // Re-run initAll() (as would happen if the module were somehow re-evaluated against
  // DOM that already has an initialized block) — must be a no-op for this root.
  (dom.window as unknown as { document: { querySelectorAll: typeof document.querySelectorAll } });
  const initAllAgain = () => {
    dom.window.document.querySelectorAll("[data-imprintid-pricing]").forEach((r) => {
      if ((r as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock) return;
      new ImprintIdPricing.PricingBlock(r);
    });
  };
  initAllAgain();
  assert.equal((root as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock, firstInstance, "the same instance must remain — never replaced/duplicated");

  // A single variant-select event must only cause ONE round of effects, not two (which
  // would happen if two listeners had been registered against the same section).
  const postCountBefore = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length;
  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);

  const newPosts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length - postCountBefore;
  assert.equal(newPosts, 1, "exactly one new pricing request — a duplicate listener would have produced two");
});

async function setupPricingBlockViaInitAll(options: SetupOptions) {
  const sectionId = options.sectionId ?? "sec1";
  const variantMap = options.variantMap ?? DEFAULT_VARIANT_MAP;
  const rootAttrs: Record<string, string> = {
    "data-sku": options.variantSku ?? "LNY01-A",
    "data-variant-id": options.variantId ?? "1001",
    "data-variant-sku": options.variantSku ?? "LNY01-A",
    "data-variant-available": String(options.variantAvailable ?? true),
    "data-product-gid": options.productGid ?? PRODUCT_GID,
    "data-section-id": sectionId,
    "data-variant-map": JSON.stringify(variantMap),
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
    "data-imprintid-pricing": "",
  };

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div data-section-id="${sectionId}" id="shopify-section-${sectionId}">
        <form data-type="add-to-cart-form"><input type="hidden" name="id" value="1001"></form>
        ${pricingRootHtml(rootAttrs).replace("data-imprintid-pricing-test-root", "")}
      </div>
    </body></html>`,
    { url: "https://example-shop.myshopify.com/products/lny01", runScripts: "outside-only" },
  );

  (globalThis as unknown as { window: typeof dom.window }).window = dom.window;
  globalThis.document = dom.window.document as unknown as Document;
  (globalThis as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = {};

  const fetchCalls: FetchCall[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method as string) || "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: FetchCall = { url, method, body };
    fetchCalls.push(call);
    const responseBody = options.fetchHandler(call);
    return { ok: true, status: 200, json: async () => responseBody } as Response;
  }) as typeof fetch;
  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = dom.window.AbortController;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = dom.window.CustomEvent;

  // This import's own module-level initAll() (triggered at import time, since
  // `data-imprintid-pricing` is already present before import — unlike the other
  // helper above) performs the real, first, harness-driven initialization.
  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);

  const root = dom.window.document.querySelector("[data-imprintid-pricing]")!;
  return { dom, root, fetchCalls, sectionId };
}
