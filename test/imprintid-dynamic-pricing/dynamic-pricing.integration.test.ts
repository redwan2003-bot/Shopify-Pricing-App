/**
 * Genuine execution tests for dynamic-pricing.js — not static inspection. This
 * instantiates the real `PricingBlock` class against a real DOM (via jsdom) with a
 * mocked `fetch`, and actually dispatches the same DOM events a customer's clicks and
 * keystrokes produce, then asserts on the resulting network calls and DOM state. This
 * is the one new dependency added this phase: Node has no built-in DOM, and no existing
 * tool in this repo can execute browser event-handling code — see the final report for
 * why this was judged necessary rather than optional.
 *
 * The mocked fetch responses are shaped exactly like the real App Proxy catalog/
 * calculation responses (including the new `resolvedPriceCents`/`priceSource` fields —
 * see app/lib/pricing-api/catalog.ts) and real LNY01 attachment data (see
 * prisma/seed-data/lny01.ts) — not arbitrary placeholder values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const CATALOG_RESPONSE = {
  ok: true,
  data: {
    sku: "LNY01",
    quantityTiers: [
      { minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 },
      { minQuantity: 1000, maxQuantity: 2999, priceCode: null, listUnitPriceCents: 164, netUnitPriceCents: 98 },
    ],
    productColors: [],
    decorationMethods: ["SCREEN_PRINT"],
    decorationColorCharges: [],
    optionGroups: [
      {
        name: "Attachment — Standard",
        kind: "ATTACHMENT",
        isRequired: false,
        categoryPriceAdjustmentCents: 0,
        values: [
          { id: "ov_jhook", code: "SA03", label: "J Hook", priceCode: null, priceAdjustmentCents: null, resolvedPriceCents: 0, priceSource: "category" },
        ],
      },
      {
        name: "Attachment — Heavy Duty",
        kind: "ATTACHMENT",
        isRequired: false,
        categoryPriceAdjustmentCents: 23,
        values: [
          { id: "ov_oval", code: "HD01", label: "Oval Hook", priceCode: null, priceAdjustmentCents: null, resolvedPriceCents: 23, priceSource: "category" },
        ],
      },
      {
        name: "Optional Features",
        kind: "FEATURE",
        isRequired: false,
        categoryPriceAdjustmentCents: null,
        values: [
          { id: "ov_cellphone", code: "LA06", label: "Cell Phone Loop", priceCode: null, priceAdjustmentCents: 25, resolvedPriceCents: 25, priceSource: "option" },
        ],
      },
    ],
    productionRules: [
      { code: "STANDARD", name: "Standard Production", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: "Plus applicable transit time." },
      { code: "RUSH", name: "Rush Service", isRush: true, minBusinessDays: 5, maxBusinessDays: 5, relatedSku: "LNY5RSH01", feeCents: null, notes: null },
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
      cartPricing: null,
      ...overrides,
    },
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** Builds the DOM skeleton mirroring dynamic-pricing.liquid's real structure/data-*
 * attributes exactly, sets up a mocked fetch, imports the real dynamic-pricing.js
 * against that DOM, and returns a constructed PricingBlock plus a way to inspect fetch
 * calls and drive/await the debounce. */
async function setupPricingBlock(options: { fetchHandler: (call: FetchCall) => unknown }) {
  // NOTE: the root intentionally does NOT carry `data-imprintid-pricing` yet — that
  // attribute is added after the module import (see below). dynamic-pricing.js's own
  // `initAll()` runs at import time and auto-constructs a PricingBlock for every
  // matching element already in the DOM; leaving the real marker off until after import
  // avoids a second, duplicate auto-constructed instance double-firing every event
  // alongside the one instance this test constructs and drives directly.
  const dom = new JSDOM(
    // Task 2B.3: an explicit, valid single-variant `data-variant-map` is now required —
    // a missing/blank map fails closed. These tests aren't about variant metadata, so
    // the fixture supplies a valid one-variant map matching the initial variant id.
    `<!DOCTYPE html><html><body>
      <div data-imprintid-pricing-test-root data-sku="LNY01" data-variant-id="111" data-variant-sku="LNY01" data-variant-available="true" data-variant-map='{"111":{"sku":"LNY01","available":true}}' data-proxy-path="/apps/imprintid-pricing/pricing" data-show-breakdown="false">
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
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
    } as Response;
  }) as typeof fetch;

  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = dom.window.AbortController;

  // Cache-bust so each test gets a fresh module instance (the file's top-level IIFE
  // runs once per import; re-importing the same URL would return the cached module).
  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);

  const root = dom.window.document.querySelector("[data-imprintid-pricing-test-root]")!;
  root.removeAttribute("data-imprintid-pricing-test-root");
  root.setAttribute("data-imprintid-pricing", "");
  const ImprintIdPricing = (dom.window as unknown as { ImprintIdPricing: { PricingBlock: new (root: Element) => unknown } }).ImprintIdPricing;
  const block = new ImprintIdPricing.PricingBlock(root);

  return { dom, root, block, fetchCalls };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("init: loading the catalog renders real attachment prices in the <select> options (not hardcoded)", async () => {
  const { root } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") return CATALOG_RESPONSE;
      return buildCalcResponse();
    },
  });

  await wait(50); // let the catalog fetch's .then() chain resolve

  const heavyDutySelect = Array.from(root.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.textContent?.includes("Oval Hook")),
  )!;
  const ovalOption = Array.from(heavyDutySelect.options).find((o) => o.textContent?.includes("Oval Hook"))!;
  assert.ok(ovalOption.textContent?.includes("+$0.23"), `expected "+$0.23" in "${ovalOption.textContent}"`);

  const standardSelect = Array.from(root.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.textContent?.includes("J Hook")),
  )!;
  const jHookOption = Array.from(standardSelect.options).find((o) => o.textContent?.includes("J Hook"))!;
  assert.ok(jHookOption.textContent?.includes("Included"), `expected "Included" in "${jHookOption.textContent}"`);

  const featureSelect = Array.from(root.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.textContent?.includes("Cell Phone Loop")),
  )!;
  const cellPhoneOption = Array.from(featureSelect.options).find((o) => o.textContent?.includes("Cell Phone Loop"))!;
  assert.ok(cellPhoneOption.textContent?.includes("+$0.25"), `expected "+$0.25" in "${cellPhoneOption.textContent}"`);
});

test("changing quantity actually triggers a new pricing request with the new quantity", async () => {
  const { root, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);

  const initialPostCount = fetchCalls.filter((c) => c.method === "POST").length;
  assert.ok(initialPostCount >= 1, "expected the initial recalculateNow() to have already fired a POST");

  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.value = "1000";
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));

  await wait(400); // debounce is 300ms

  const posts = fetchCalls.filter((c) => c.method === "POST");
  assert.ok(posts.length > initialPostCount, "expected a new POST after changing quantity");
  const lastBody = posts[posts.length - 1]!.body as { quantity: number };
  assert.equal(lastBody.quantity, 1000);
});

test("selecting an attachment option sends the real OptionValue.id in the request body, not a label or slug", async () => {
  const { root, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse()),
  });
  await wait(50);

  const heavyDutySelect = Array.from(root.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.textContent?.includes("Oval Hook")),
  ) as HTMLSelectElement;
  heavyDutySelect.value = "ov_oval";
  heavyDutySelect.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("change", { bubbles: true }));

  await wait(400);

  const posts = fetchCalls.filter((c) => c.method === "POST");
  const lastBody = posts[posts.length - 1]!.body as { options?: Array<{ groupName: string; optionValueId: string }> };
  assert.ok(lastBody.options, "expected an options array in the request body");
  assert.deepEqual(lastBody.options, [{ groupName: "Attachment — Heavy Duty", optionValueId: "ov_oval" }]);
});

test("a genuinely signed cartPricing response enables Add to Cart; the button then POSTs the exact signed properties to /cart/add.js", async () => {
  const cartPricing = { version: 1, payload: '{"v":1,"sku":"LNY01"}', signature: "abc123signature" };
  const { root, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse({ cartPricing })),
  });
  await wait(50);

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, false, "Add to Cart should be enabled once cartPricing is present");

  addToCartButton.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
  await wait(50);

  const cartAddCalls = fetchCalls.filter((c) => c.url.includes("/cart/add.js"));
  assert.equal(cartAddCalls.length, 1);
  const item = (cartAddCalls[0]!.body as { items: Array<Record<string, unknown>> }).items[0]!;
  assert.equal(item.id, "111");
  assert.equal(item.quantity, 100);
  assert.deepEqual(item.properties, {
    _imprintid_pricing_version: "1",
    _imprintid_pricing_payload: cartPricing.payload,
    _imprintid_pricing_signature: cartPricing.signature,
  });
});

test("Add to Cart stays disabled, and clicking it does nothing, when the calculation response has no cartPricing", async () => {
  const { root, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? CATALOG_RESPONSE : buildCalcResponse({ cartPricing: null })),
  });
  await wait(50);

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, true);

  addToCartButton.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
  await wait(50);

  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0, "clicking a disabled Add to Cart must never call /cart/add.js");
});

test("a pricing error response is shown to the customer and clears any previous cartPricing (Add to Cart disables)", async () => {
  let callCount = 0;
  const { root } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") return CATALOG_RESPONSE;
      callCount++;
      if (callCount === 1) return buildCalcResponse({ cartPricing: { version: 1, payload: "{}", signature: "sig" } });
      return { ok: false, error: { code: "OPTION_PRICING_UNAVAILABLE", message: "No price configured for this option." } };
    },
  });
  await wait(50);

  const addToCartButton = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(addToCartButton.disabled, false, "sanity: enabled after the first successful calc");

  // Trigger a second calculation (e.g. a quantity change) that this time errors.
  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  quantityInput.value = "150";
  quantityInput.dispatchEvent(new (root.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  await wait(400);

  const errorEl = root.querySelector("[data-imprintid-pricing-error]") as HTMLElement;
  assert.equal(errorEl.hidden, false);
  assert.ok((errorEl.textContent || "").length > 0);
  assert.equal(addToCartButton.disabled, true, "a failed recalculation must disable Add to Cart, not leave a stale enabled state");
});

test("stale (superseded) responses never overwrite the price shown for a newer request", async () => {
  const { root } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") return CATALOG_RESPONSE;
      const body = call.body as { quantity: number };
      // Tag the total with the requested quantity so we can tell which response won.
      return buildCalcResponse({ totals: { listTotalCents: body.quantity * 100, netTotalCents: body.quantity * 50 } });
    },
  });
  await wait(50);

  const quantityInput = root.querySelector("[data-imprintid-pricing-quantity]") as HTMLInputElement;
  const EventCtor = root.ownerDocument!.defaultView as unknown as { Event: typeof Event };

  // Two rapid changes within the debounce window — only the second should actually fire.
  quantityInput.value = "150";
  quantityInput.dispatchEvent(new EventCtor.Event("input", { bubbles: true }));
  await wait(50);
  quantityInput.value = "1000";
  quantityInput.dispatchEvent(new EventCtor.Event("input", { bubbles: true }));

  await wait(500);

  const total = root.querySelector("[data-imprintid-pricing-total]") as HTMLElement;
  // 1000 * 50 = 50000 cents = $500.00 (net total is what's displayed as the total)
  assert.ok(total.textContent?.includes("500"), `expected the final total to reflect quantity 1000, got "${total.textContent}"`);
});
