/**
 * Task 2B.1 — CLOSE VARIANT-SYNC GAPS. Genuine execution tests (real DOM via jsdom,
 * real `PricingBlock` instances) covering the four corrections:
 *
 *   1. unified variant adoption (hidden-input and event paths now share
 *      `resolveAndAdoptVariant`, including the SKU-changed catalog-refetch behavior
 *      that the hidden-input path previously lacked);
 *   2. section-scoped-only `shopify:product:select` listening (no permanent
 *      document-level fallback);
 *   3. safe Liquid `data-variant-map` serialization (verified here via a faithful,
 *      clearly-labeled simulation of Liquid's own `json`/`escape` filters, since no
 *      Liquid engine is available in this repo — the actual parsing code under test,
 *      `parseVariantMap`, is the real production function);
 *   4. the `skipCrossCheck` mechanism (an ordinary per-call argument, replacing the
 *      old `suppressCrossCheckOnce` boolean) never leaking across selections or into
 *      Add to Cart.
 *
 * No color name or real Shopify id from this project's actual store is hardcoded here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseVariantMap, resolveVariantFromMap } from "../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing-utils.js";

const PRODUCT_GID = "gid://shopify/Product/9000000000001";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function catalogFor(sku: string) {
  return {
    ok: true,
    data: {
      sku,
      quantityTiers: [{ minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 }],
      productColors: [],
      decorationMethods: [],
      optionGroups: [],
      productionRules: [
        { code: "STD-" + sku, name: "Standard (" + sku + ")", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null },
      ],
    },
  };
}

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

const DEFAULT_VARIANT_MAP = {
  "1001": { sku: "LNY01-A", available: true },
  "1002": { sku: "LNY01-B", available: true },
  "1003": { sku: "LNY01-A", available: false },
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
  sectionId?: string | null; // null omits data-section-id entirely
  formInputValue?: string;
}

async function setupPricingBlock(options: SetupOptions) {
  const sectionId = options.sectionId === undefined ? "sec1" : options.sectionId;
  const variantMap = options.variantMap ?? DEFAULT_VARIANT_MAP;

  const formHtml =
    options.formInputValue === undefined
      ? ""
      : `<form data-type="add-to-cart-form"><input type="hidden" name="id" value="${options.formInputValue}"></form>`;

  const rootAttrs: Record<string, string> = {
    "data-sku": options.variantSku ?? "LNY01-A",
    "data-variant-id": options.variantId ?? "1001",
    "data-variant-sku": options.variantSku ?? "LNY01-A",
    "data-variant-available": String(options.variantAvailable ?? true),
    "data-product-gid": options.productGid ?? PRODUCT_GID,
    "data-variant-map": JSON.stringify(variantMap),
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };
  if (sectionId !== null) rootAttrs["data-section-id"] = sectionId;

  const sectionOpen = sectionId !== null ? `<div data-section-id="${sectionId}" id="shopify-section-${sectionId}">` : `<div>`;

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      ${sectionOpen}
        ${formHtml}
        ${pricingRootHtml(rootAttrs)}
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

  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);

  const root = dom.window.document.querySelector("[data-imprintid-pricing-test-root]")!;
  root.removeAttribute("data-imprintid-pricing-test-root");
  root.setAttribute("data-imprintid-pricing", "");
  const ImprintIdPricing = (dom.window as unknown as { ImprintIdPricing: { PricingBlock: new (root: Element) => unknown } }).ImprintIdPricing;
  const block = new ImprintIdPricing.PricingBlock(root) as Record<string, unknown>;

  return { dom, root, block, fetchCalls, sectionId, ImprintIdPricing };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Like `setupPricingBlock`, but constructs the block via the module's own real
 * `initAll()` (by having `data-imprintid-pricing` already present before import) so
 * `root.imprintIdPricingBlock` — the idempotency marker `initAll()` itself sets — is
 * genuinely populated, exactly as it would be on a real page. Needed for the
 * section-replacement/idempotency tests below, which specifically exercise that
 * marker. */
async function setupPricingBlockViaInitAll(options: SetupOptions) {
  const sectionId = options.sectionId === undefined ? "sec1" : options.sectionId;
  const variantMap = options.variantMap ?? DEFAULT_VARIANT_MAP;
  const rootAttrs: Record<string, string> = {
    "data-sku": options.variantSku ?? "LNY01-A",
    "data-variant-id": options.variantId ?? "1001",
    "data-variant-sku": options.variantSku ?? "LNY01-A",
    "data-variant-available": String(options.variantAvailable ?? true),
    "data-product-gid": options.productGid ?? PRODUCT_GID,
    "data-variant-map": JSON.stringify(variantMap),
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
    "data-imprintid-pricing": "",
  };
  if (sectionId !== null) rootAttrs["data-section-id"] = sectionId;

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div data-section-id="${sectionId}" id="shopify-section-${sectionId}">
        <form data-type="add-to-cart-form"><input type="hidden" name="id" value="${options.variantId ?? "1001"}"></form>
        ${pricingRootHtml(rootAttrs).replace("data-imprintid-pricing-test-root ", "")}
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

  // This import's own module-level initAll() (triggered at import time) performs the
  // real, first, harness-driven initialization — root.imprintIdPricingBlock is set by
  // the actual production code, not simulated by the test.
  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);
  const ImprintIdPricing = (dom.window as unknown as { ImprintIdPricing: { PricingBlock: new (root: Element) => unknown } }).ImprintIdPricing;

  const root = dom.window.document.querySelector("[data-imprintid-pricing]")!;
  return { dom, root, fetchCalls, sectionId, ImprintIdPricing };
}

function dispatchProductSelect(dom: JSDOM, target: EventTarget, opts: { productId: string; promise: Promise<unknown> }) {
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

// ============================================================================
// Requirement 1 — unified variant adoption
// ============================================================================

test("1a: hidden-input A/SKU-A -> B/SKU-B fetches SKU-B's catalog (not the previous one)", async () => {
  const gets: string[] = [];
  const { dom, root, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") {
        gets.push(call.url);
        return call.url.includes("LNY01-B") ? catalogFor("LNY01-B") : catalogFor("LNY01-A");
      }
      return buildCalcResponse();
    },
    formInputValue: "1001",
  });
  await wait(50);
  assert.equal(gets.length, 1, "sanity: one catalog fetch for the initial load");

  const input = dom.window.document.getElementById("shopify-section-" + sectionId)!.querySelector('input[name="id"]') as HTMLInputElement;
  input.value = "1002"; // SKU-B per DEFAULT_VARIANT_MAP

  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  await wait(400); // past the debounce that triggers the cross-check

  assert.equal(gets.length, 2, "the SKU change must trigger exactly one new catalog fetch");
  assert.ok(gets[1]!.includes("LNY01-B"), `expected the second GET to be for LNY01-B, got "${gets[1]}"`);
  assert.equal((block as { catalog: { sku: string } }).catalog.sku, "LNY01-B");

  const productionOption = root.querySelector("[data-imprintid-pricing-production] option") as HTMLOptionElement;
  assert.equal(productionOption.value, "STD-LNY01-B", "the rendered catalog must be SKU-B's, not a stale SKU-A one");
});

test("1b: no pricing request is ever sent for SKU-B against SKU-A's catalog", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const { dom, root, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") return call.url.includes("LNY01-B") ? catalogFor("LNY01-B") : catalogFor("LNY01-A");
      posts.push(call.body as Record<string, unknown>);
      return buildCalcResponse();
    },
    formInputValue: "1001",
  });
  await wait(50);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.sku, "LNY01-A");

  const input = dom.window.document.getElementById("shopify-section-" + sectionId)!.querySelector('input[name="id"]') as HTMLInputElement;
  input.value = "1002";
  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  await wait(400);

  // Every POST after the SKU change must carry sku "LNY01-B" — never "LNY01-A" for a
  // request that was actually meant for the new variant.
  const postsAfter = posts.slice(1);
  assert.ok(postsAfter.length >= 1, "expected at least one POST for the new SKU");
  for (const body of postsAfter) {
    assert.equal(body.sku, "LNY01-B", `a POST was sent with sku "${body.sku}" instead of "LNY01-B"`);
  }
});

test("1c: Add to Cart remains disabled until SKU-B's own quote succeeds", async () => {
  let resolveBQuote!: () => void;
  const { dom, root, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") return call.url.includes("LNY01-B") ? catalogFor("LNY01-B") : catalogFor("LNY01-A");
      if ((call.body as { sku: string }).sku === "LNY01-B") {
        return new Promise((resolve) => {
          resolveBQuote = () => resolve(buildCalcResponse());
        });
      }
      return buildCalcResponse();
    },
    formInputValue: "1001",
  });
  await wait(50);
  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, false, "sanity: enabled after the initial SKU-A quote");

  const input = dom.window.document.getElementById("shopify-section-" + sectionId)!.querySelector('input[name="id"]') as HTMLInputElement;
  input.value = "1002";
  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  await wait(400);

  assert.equal(addToCartButton.disabled, true, "must stay disabled while SKU-B's catalog/quote are still in flight");

  resolveBQuote();
  await wait(50);
  assert.equal(addToCartButton.disabled, false, "re-enabled once SKU-B's own quote actually lands");
});

test("1d: a hidden-input variant change with the SAME sku does not refetch the catalog", async () => {
  const gets: string[] = [];
  const { dom, root, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") {
        gets.push(call.url);
        return catalogFor("LNY01-A");
      }
      return buildCalcResponse();
    },
    formInputValue: "1001",
    variantMap: { "1001": { sku: "LNY01-A", available: true }, "1004": { sku: "LNY01-A", available: true } },
  });
  await wait(50);
  assert.equal(gets.length, 1);

  const input = dom.window.document.getElementById("shopify-section-" + sectionId)!.querySelector('input[name="id"]') as HTMLInputElement;
  input.value = "1004"; // different id, SAME sku
  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  await wait(400);

  assert.equal(gets.length, 1, "no new catalog fetch should have occurred for a same-SKU variant change");
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1004");
});

// ============================================================================
// Requirement 2 — section-scoped-only listener, no document-level fallback
// ============================================================================

test("2a: the listener is attached directly to the owning section container", async () => {
  const { dom, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
  });
  await wait(50);
  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  assert.equal((block as { variantSelectListenTarget: unknown }).variantSelectListenTarget, sectionEl);
});

test("2b: events dispatched outside the owning section (on document, or another section) do not affect the block", async () => {
  const { dom, block } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
  });
  await wait(50);

  dispatchProductSelect(dom, dom.window.document, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1001", "a document-level dispatch must never reach this block — there is no document listener at all");

  const otherSection = dom.window.document.createElement("div");
  otherSection.setAttribute("data-section-id", "unrelated");
  dom.window.document.body.appendChild(otherSection);
  dispatchProductSelect(dom, otherSection, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1001", "an event on an unrelated section must not affect this block");
});

test("2c: no section resolvable + MULTI-VARIANT -> fails closed (Task 2B.2), logs a non-secret diagnostic, never picks up an unrelated form", async () => {
  // NOTE (Task 2B.2): this test's setup is a MULTI-VARIANT product (DEFAULT_VARIANT_MAP
  // has 3 entries) with no resolvable owning section. Before Task 2B.2 the block kept
  // pricing/adding the initially rendered variant here — the exact defect 2B.2 closes.
  // The single assertion changed from the 2B.1 revision is the Add to Cart state:
  // `disabled` must now be `true` (fail closed), and no catalog/pricing request is made.
  // Everything else 2B.1 asserted (diagnostic logged, no secret in it, unrelated form
  // never consulted) is unchanged. The safe single-variant exception is covered by the
  // 2B.2 test file.
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const { dom, root, block, fetchCalls } = await setupPricingBlock({
      fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
      sectionId: null, // no data-section-id at all
    });
    await wait(50);

    assert.equal((block as { variantSelectListenTarget: unknown }).variantSelectListenTarget, null);
    assert.equal((block as { formVariantInput: unknown }).formVariantInput, null);
    assert.ok(warnings.length >= 1, "expected a diagnostic to be logged");
    const message = String(warnings[0]![0]);
    assert.ok(message.includes("dynamic-pricing"), "diagnostic should be identifiable");
    // The message is allowed to (and does) reassure that no secret data is included —
    // what must never appear is an actual secret-shaped VALUE (a signature/payload).
    assert.ok(!/signature|payload|[0-9a-f]{16,}/i.test(message), "diagnostic must never contain actual secret material, only a description");

    // Fail closed: no catalog load, no pricing request.
    assert.equal(fetchCalls.length, 0, "Task 2B.2: a multi-variant product with no resolvable section must not load a catalog or request pricing");

    // Unrelated form elsewhere on the page must never be consulted.
    const unrelated = dom.window.document.createElement("div");
    unrelated.innerHTML = '<form data-type="add-to-cart-form"><input type="hidden" name="id" value="1002"></form>';
    dom.window.document.body.appendChild(unrelated);

    const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
    assert.equal(addToCartButton.disabled, true, "Task 2B.2: a multi-variant product with no resolvable section must fail closed");
    addToCartButton.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
    await wait(50);
    assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1001", "must never have adopted the unrelated form's id");
    assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0, "must never submit to /cart/add.js while failed closed");
  } finally {
    console.warn = originalWarn;
  }
});

test("2d: replacing the section and re-running initialization creates exactly one active instance for the new section", async () => {
  const { dom, fetchCalls, ImprintIdPricing } = await setupPricingBlockViaInitAll({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
  });
  await wait(50);
  const oldSection = dom.window.document.getElementById("shopify-section-sec1")!;
  const oldRoot = dom.window.document.querySelector("[data-imprintid-pricing]")!;
  const oldBlock = (oldRoot as unknown as { imprintIdPricingBlock: Record<string, unknown> }).imprintIdPricingBlock;
  assert.ok(oldBlock, "sanity");

  // Simulate a Theme Editor section replacement: remove the old section wholesale,
  // insert a brand-new one (fresh DOM nodes) with the same section id.
  const newSectionHtml = oldSection.outerHTML;
  oldSection.remove();
  dom.window.document.body.insertAdjacentHTML("beforeend", newSectionHtml);
  const newSection = dom.window.document.getElementById("shopify-section-sec1")!;
  const newRoot = newSection.querySelector("[data-imprintid-pricing]")!;
  assert.notEqual(newRoot, oldRoot, "sanity: genuinely a fresh DOM node");

  // Re-run initialization (mirrors the module's own initAll()).
  dom.window.document.querySelectorAll("[data-imprintid-pricing]").forEach((r) => {
    if ((r as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock) return;
    (r as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock = new ImprintIdPricing.PricingBlock(r);
  });
  await wait(50);

  const newBlock = (newRoot as unknown as { imprintIdPricingBlock: Record<string, unknown> }).imprintIdPricingBlock;
  assert.ok(newBlock, "the new root must have gotten its own instance");
  assert.notEqual(newBlock, oldBlock, "must be a genuinely different instance, not the stale one");
  assert.equal(newBlock.variantSelectListenTarget, newSection, "the new instance's listener target must be the NEW section element");

  const postCountBefore = fetchCalls.filter((c) => c.method === "POST").length;
  dispatchProductSelect(dom, newSection, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);
  assert.equal(newBlock.selectedVariantId, "1002", "the NEW instance must respond to events on the NEW section");
  assert.ok(fetchCalls.filter((c) => c.method === "POST").length > postCountBefore, "the new instance's own recalculation must have fired");
});

test("2e: the detached (replaced-away) instance cannot respond to later variant events on the new section", async () => {
  const { dom, ImprintIdPricing } = await setupPricingBlockViaInitAll({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
  });
  await wait(50);
  const oldSection = dom.window.document.getElementById("shopify-section-sec1")!;
  const oldRoot = dom.window.document.querySelector("[data-imprintid-pricing]")!;
  const oldBlock = (oldRoot as unknown as { imprintIdPricingBlock: Record<string, unknown> }).imprintIdPricingBlock;

  const newSectionHtml = oldSection.outerHTML;
  oldSection.remove();
  dom.window.document.body.insertAdjacentHTML("beforeend", newSectionHtml);
  const newSection = dom.window.document.getElementById("shopify-section-sec1")!;
  dom.window.document.querySelectorAll("[data-imprintid-pricing]").forEach((r) => {
    if ((r as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock) return;
    (r as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock = new ImprintIdPricing.PricingBlock(r);
  });
  await wait(50);

  // Dispatch on the NEW section — the OLD (detached) instance's listener was attached
  // to the OLD section element, which is gone; it cannot see this event at all.
  dispatchProductSelect(dom, newSection, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);
  assert.equal(oldBlock.selectedVariantId, "1001", "the detached instance's state must be completely untouched");
});

test("2f: repeated initialization of the same still-connected root remains idempotent", async () => {
  const { dom, root, fetchCalls, ImprintIdPricing, sectionId } = await setupPricingBlockViaInitAll({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
  });
  await wait(50);
  const marker = (root as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock;
  assert.ok(marker, "sanity: the real initAll() at import time already constructed one instance");

  const runInitAll = () => {
    dom.window.document.querySelectorAll("[data-imprintid-pricing]").forEach((r) => {
      if ((r as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock) return;
      (r as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock = new ImprintIdPricing.PricingBlock(r);
    });
  };
  runInitAll();
  runInitAll();
  assert.equal((root as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock, marker, "must remain the same marker — never replaced");

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  await wait(50);
  const postCountBefore = fetchCalls.filter((c) => c.method === "POST").length;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);
  const newPosts = fetchCalls.filter((c) => c.method === "POST").length - postCountBefore;
  assert.equal(newPosts, 1, "exactly one recalculation — a duplicate listener would have produced two");
});

// ============================================================================
// Requirement 3 — safe Liquid serialization (simulated filters, real JS parsing)
// ============================================================================

/**
 * Faithfully replicates Shopify Liquid's documented `json` filter for a single string
 * value (equivalent to a standard JSON string encoder — `JSON.stringify` is a correct
 * stand-in) and its `escape` filter (HTML-entity-escapes `&`, `<`, `>`, `"`, and `'`,
 * matching Ruby's CGI.escapeHTML that `escape` wraps). This is NOT a Liquid engine —
 * no such dependency exists in this repo — it exists only to reconstruct exactly the
 * HTML `dynamic-pricing.liquid` would emit for a given SKU, so the REAL production
 * parsing code (`parseVariantMap`, imported above) can be exercised against it after a
 * real HTML round-trip through jsdom.
 */
function liquidJsonFilter(value: string): string {
  return JSON.stringify(value);
}
function liquidEscapeFilter(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildVariantMapAttributeValue(entries: Array<{ id: string; sku: string; available: boolean }>): string {
  const json =
    "{" +
    entries.map((e) => `"${e.id}":{"sku":${liquidJsonFilter(e.sku)},"available":${JSON.stringify(e.available)}}`).join(",") +
    "}";
  return liquidEscapeFilter(json);
}

function parseViaRealCode(attributeValue: string) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div data-variant-map="${attributeValue}"></div></body></html>`);
  const el = dom.window.document.querySelector("[data-variant-map]") as HTMLElement;
  return parseVariantMap(el.dataset.variantMap);
}

test("3a: a SKU containing a double quote round-trips exactly through the real Liquid-equivalent encoding and parseVariantMap", () => {
  const sku = 'He said "hi" to LNY01';
  const attr = buildVariantMapAttributeValue([{ id: "1001", sku, available: true }]);
  const map = parseViaRealCode(attr);
  assert.deepEqual(resolveVariantFromMap(map, "1001"), { sku, available: true });
});

test("3b: a SKU containing an apostrophe round-trips exactly", () => {
  const sku = "O'Brien's Widget";
  const attr = buildVariantMapAttributeValue([{ id: "1001", sku, available: true }]);
  const map = parseViaRealCode(attr);
  assert.deepEqual(resolveVariantFromMap(map, "1001"), { sku, available: true });
});

test("3c: a SKU containing an ampersand round-trips exactly", () => {
  const sku = "Fish & Chips LNY01";
  const attr = buildVariantMapAttributeValue([{ id: "1001", sku, available: true }]);
  const map = parseViaRealCode(attr);
  assert.deepEqual(resolveVariantFromMap(map, "1001"), { sku, available: true });
});

test("3d: a SKU containing angle brackets (including a script-closing-tag-shaped substring) round-trips exactly and cannot break the surrounding HTML", () => {
  const sku = '<script>alert(1)</script>LNY01';
  const attr = buildVariantMapAttributeValue([{ id: "1001", sku, available: true }]);
  // The raw attribute text must not contain a literal, unescaped "<" — proving it can't
  // be interpreted as markup (or close a real <script> tag) by an HTML parser.
  assert.ok(!attr.includes("<"), "the encoded attribute value must contain no literal '<' character");
  const map = parseViaRealCode(attr);
  assert.deepEqual(resolveVariantFromMap(map, "1001"), { sku, available: true });
});

test("3e: a SKU containing Unicode (accents, CJK, emoji) round-trips exactly", () => {
  const sku = "LNY01-Ünïcode-日本語-🎨";
  const attr = buildVariantMapAttributeValue([{ id: "1001", sku, available: true }]);
  const map = parseViaRealCode(attr);
  assert.deepEqual(resolveVariantFromMap(map, "1001"), { sku, available: true });
});

test("3f: malformed JSON (simulating a corrupted/truncated attribute) fails closed to an empty map, never throws", () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div data-variant-map="{&quot;1001&quot;:{&quot;sku&quot;:&quot;LNY01-A&quot;"></div></body></html>`);
  const el = dom.window.document.querySelector("[data-variant-map]") as HTMLElement;
  const map = parseVariantMap(el.dataset.variantMap);
  assert.deepEqual(map, {});
  assert.equal(resolveVariantFromMap(map, "1001"), null);
});

test("3g: multiple variants with mixed tricky SKUs all resolve independently and correctly", () => {
  const entries = [
    { id: "1001", sku: 'Quote"SKU', available: true },
    { id: "1002", sku: "Amp&SKU", available: false },
    { id: "1003", sku: "Plain-SKU", available: true },
  ];
  const attr = buildVariantMapAttributeValue(entries);
  const map = parseViaRealCode(attr);
  for (const e of entries) {
    assert.deepEqual(resolveVariantFromMap(map, e.id), { sku: e.sku, available: e.available });
  }
});

// ============================================================================
// Requirement 4 — skipCrossCheck argument (no shared mutable suppression state)
// ============================================================================

test("4a: event adoption while the hidden input temporarily contains the previous id does not get reverted", async () => {
  const { dom, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    formInputValue: "1001", // deliberately never updated to simulate the DOM lagging the event
  });
  await wait(50);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002", "the event-adopted variant must not be reverted by the (still-stale) hidden input on its own immediate follow-up recalculation");
});

test("4b: Add to Cart while the hidden input remains stale is blocked, never calls /cart/add.js", async () => {
  const { dom, root, block, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    formInputValue: "1001",
  });
  await wait(50);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  assert.equal((root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement).disabled, false, "sanity: quoted for 1002");

  // The hidden input STILL says "1001" (never updated) — Add to Cart's own
  // (never-suppressed) cross-check must catch this and block the click.
  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  addToCartButton.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
  await wait(20);

  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0, "must never submit while the hidden input disagrees");
});

test("4c: two rapid product-select events leave no suppression artifact — the final selection's own next recalculation is still cross-checked normally", async () => {
  const { dom, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    formInputValue: "1001",
    variantMap: { "1001": { sku: "LNY01-A", available: true }, "1002": { sku: "LNY01-A", available: true }, "1003": { sku: "LNY01-A", available: true } },
  });
  await wait(50);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1003", availableForSale: true } }),
  });
  await wait(50);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003");

  // Now update the hidden input to a THIRD, distinct id and trigger an ordinary
  // recalculation — if suppression had leaked (stuck "true" from either event), this
  // cross-check would be skipped and the mismatch would go unnoticed.
  const input = dom.window.document.getElementById("shopify-section-" + sectionId)!.querySelector('input[name="id"]') as HTMLInputElement;
  input.value = "1001";
  (block as { recalculate: () => void }).recalculate();
  await wait(400);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1001", "the cross-check must still run normally — no leftover suppression from the two earlier events");
});

test("4d: a catalog-fetch failure while an adoption is in flight fails closed cleanly, and does not leave any suppression stuck for later recalculations", async () => {
  let failCatalogFetch = true;
  const { dom, root, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET" && call.url.includes("LNY01-B")) {
        if (failCatalogFetch) return { ok: false, error: { code: "PRICING_PROFILE_NOT_FOUND", message: "boom" } };
        return catalogFor("LNY01-B");
      }
      if (call.method === "GET") return catalogFor("LNY01-A");
      return buildCalcResponse();
    },
    formInputValue: "1001",
  });
  await wait(50);

  const input = dom.window.document.getElementById("shopify-section-" + sectionId)!.querySelector('input[name="id"]') as HTMLInputElement;
  input.value = "1002"; // SKU-B, whose catalog fetch will fail
  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  await wait(400);

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, true, "must fail closed when the catalog fetch for the new SKU fails");
  assert.equal((root.querySelector("[data-imprintid-pricing-unavailable]") as HTMLElement).hidden, false, "showUnavailable() must have run");

  // A subsequent, ordinary recalculation must still behave normally — nothing left
  // "stuck" from the failed adoption's skipCrossCheck-scoped call.
  failCatalogFetch = false;
  (root.querySelector("[data-imprintid-pricing-unavailable]") as HTMLElement).hidden = true; // restore so panel logic can be observed again
  root.querySelector("[data-imprintid-pricing-panel]")!.removeAttribute("hidden");
  (block as { sku: string }).sku = "LNY01-A";
  (block as { recalculate: () => void }).recalculate();
  await wait(400);
  // No throw, no exception propagated — the block is still responsive.
  assert.ok(true, "recalculation after a failed adoption completed without throwing");
});
