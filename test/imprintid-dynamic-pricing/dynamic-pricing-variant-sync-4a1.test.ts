/**
 * Task 4A.1 — CLOSE PRODUCT-CONTEXT BYPASSES (storefront client side). Genuine
 * execution tests (real jsdom, real `PricingBlock`, mocked `fetch`). Focus:
 *   - a successful product-context response MUST carry a valid, matching `identity`;
 *   - a blank selected SKU accepts only `resolutionSource: "product_override"`;
 *   - `canUseDynamicPricing()` and Add to Cart evaluate the ACTIVE selected variant,
 *     not the initially rendered one.
 * On any identity failure the block fails closed: clears cartPricing + quoted identity,
 * keeps Add to Cart disabled, shows a safe error, renders nothing, never hits
 * `/cart/add.js`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const PRODUCT_GID = "gid://shopify/Product/9442404663548";
const PRODUCT_ID = "9442404663548";

const LOCALE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../extensions/imprintid-dynamic-pricing/locales/en.default.json", import.meta.url)), "utf8"),
) as { dynamic_pricing: Record<string, string> };
const STRINGS: Record<string, string> = Object.fromEntries(
  Object.entries(LOCALE.dynamic_pricing).map(([k, v]) => ["dynamic_pricing." + k, v]),
);
const CONFIG_ERROR = STRINGS["dynamic_pricing.configuration_error"]!;

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function pricingRootHtml(attrs: Record<string, string>) {
  const attrString = Object.entries(attrs).map(([k, v]) => `${k}="${v.replace(/"/g, "&quot;")}"`).join(" ");
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

function catalog(identity: unknown) {
  return {
    ok: true,
    data: {
      sku: "", identity,
      quantityTiers: [{ minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 }],
      productColors: [], decorationMethods: [], optionGroups: [],
      productionRules: [{ code: "STD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null }],
    },
  };
}
function calc(identity: unknown) {
  return {
    ok: true,
    data: {
      quantity: 100,
      quantityTier: { id: "t1", minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 },
      availableQuantityTiers: [],
      base: { quantity: 100, listUnitPriceCents: 229, netUnitPriceCents: 137, listSubtotalCents: 22900, netSubtotalCents: 13700 },
      productColor: null, decoration: null, options: { selections: [], chargesCents: 0 },
      production: { code: "STD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null },
      packaging: null, totals: { listTotalCents: 22900, netTotalCents: 13700 },
      cartPricing: { version: 1, payload: '{"v":1}', signature: "sig" }, identity,
    },
  };
}

interface SetupOptions {
  /** identity factory for GET (given the resolved {pid,vid}); default: valid product_override. */
  catalogIdentity?: (pid: string, vid: string) => unknown;
  /** identity factory for POST; default: valid product_override. */
  calcIdentity?: (pid: string, vid: string) => unknown;
  variantMap?: Record<string, { sku: string; available: boolean }>;
  variantId?: string;
  variantSku?: string;
  shopifyProductId?: string | null;
}

const OVERRIDE_ID = (pid: string, vid: string) => ({ shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "product_override" });

async function setup(options: SetupOptions) {
  const catId = options.catalogIdentity ?? OVERRIDE_ID;
  const calcId = options.calcIdentity ?? OVERRIDE_ID;
  const rootAttrs: Record<string, string> = {
    "data-sku": options.variantSku ?? "",
    "data-variant-id": options.variantId ?? "1001",
    "data-variant-sku": options.variantSku ?? "",
    "data-variant-available": "true",
    "data-product-gid": PRODUCT_GID,
    "data-section-id": "sec1",
    "data-variant-map": JSON.stringify(options.variantMap ?? { "1001": { sku: "", available: true }, "1002": { sku: "", available: true } }),
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };
  if (options.shopifyProductId !== null) rootAttrs["data-shopify-product-id"] = options.shopifyProductId ?? PRODUCT_ID;

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div data-section-id="sec1" id="shopify-section-sec1">${pricingRootHtml(rootAttrs)}</div></body></html>`,
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
    fetchCalls.push({ url, method, body });
    let payload: unknown;
    if (method === "GET") {
      const u = new URL(url, "https://x.test");
      payload = catalog(catId(u.searchParams.get("shopifyProductId") ?? "", u.searchParams.get("shopifyVariantId") ?? ""));
    } else {
      payload = calc(calcId(String(body?.shopifyProductId ?? ""), String(body?.shopifyVariantId ?? "")));
    }
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = dom.window.AbortController;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = dom.window.CustomEvent;

  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);
  const root = dom.window.document.querySelector("[data-imprintid-pricing-test-root]")!;
  root.removeAttribute("data-imprintid-pricing-test-root");
  root.setAttribute("data-imprintid-pricing", "");
  const ImprintIdPricing = (dom.window as unknown as { ImprintIdPricing: { PricingBlock: new (r: Element) => unknown } }).ImprintIdPricing;
  const block = new ImprintIdPricing.PricingBlock(root) as Record<string, unknown>;
  return { dom, root, block, fetchCalls };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const btn = (root: Element) => root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
const errText = (root: Element) => (root.querySelector("[data-imprintid-pricing-error]") as HTMLElement).textContent;
const cartAdds = (c: FetchCall[]) => c.filter((x) => x.url.includes("/cart/add.js")).length;

function expectFailClosed(root: Element, block: Record<string, unknown>, fetchCalls: FetchCall[]) {
  assert.equal(btn(root).disabled, true, "Add to Cart stays disabled");
  assert.equal((block as { cartPricing: unknown }).cartPricing, null, "cartPricing cleared");
  assert.equal((block as { quotedVariantId: unknown }).quotedVariantId, null, "quoted identity cleared");
  assert.equal((block as { quotedProductId: unknown }).quotedProductId, null);
  assert.ok((errText(root) || "").length > 0, "a safe error is shown");
  assert.equal(cartAdds(fetchCalls), 0, "no /cart/add.js");
}

// ============================================================================

test("7: a successful pricing response with NO identity is rejected (fails closed)", async () => {
  const { root, block, fetchCalls } = await setup({ calcIdentity: () => undefined });
  await wait(80);
  expectFailClosed(root, block, fetchCalls);
  assert.equal(errText(root), CONFIG_ERROR);
});

test("8: a null / malformed identity is rejected", async () => {
  const nullCase = await setup({ calcIdentity: () => null });
  await wait(80);
  expectFailClosed(nullCase.root, nullCase.block, nullCase.fetchCalls);

  const malformed = await setup({ calcIdentity: () => ({ shopifyProductId: 123, shopifyVariantId: [], resolutionSource: "sku" }) });
  await wait(80);
  expectFailClosed(malformed.root, malformed.block, malformed.fetchCalls);
});

test("9: an identity missing resolutionSource is rejected", async () => {
  const { root, block, fetchCalls } = await setup({
    calcIdentity: (pid, vid) => ({ shopifyProductId: pid, shopifyVariantId: vid }),
  });
  await wait(80);
  expectFailClosed(root, block, fetchCalls);
});

test("10: a BLANK selected SKU + resolutionSource 'sku' is rejected (fails closed)", async () => {
  const { root, block, fetchCalls } = await setup({
    calcIdentity: (pid, vid) => ({ shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "sku" }),
  });
  await wait(80);
  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "", "the selected variant is blank-SKU");
  expectFailClosed(root, block, fetchCalls);
});

test("11: a BLANK selected SKU + resolutionSource 'product_override' succeeds", async () => {
  const { root, block, fetchCalls } = await setup({}); // default OVERRIDE_ID
  await wait(80);
  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "");
  assert.equal(btn(root).disabled, false, "Add to Cart enabled");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1001");
  const p = fetchCalls.find((c) => c.method === "POST")!;
  assert.equal(p.body!.shopifyProductId, PRODUCT_ID);
});

test("12: a NON-blank selected SKU + resolutionSource 'sku' succeeds", async () => {
  const { root, block } = await setup({
    variantMap: { "1001": { sku: "REAL-A", available: true }, "1002": { sku: "REAL-B", available: true } },
    variantId: "1001",
    variantSku: "REAL-A",
    catalogIdentity: (pid, vid) => ({ shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "sku" }),
    calcIdentity: (pid, vid) => ({ shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "sku" }),
  });
  await wait(80);
  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "REAL-A");
  assert.equal(btn(root).disabled, false);
});

test("13: mixed-SKU switching evaluates the ACTIVE SKU, not the initial one — non-blank -> blank with no product id fails closed", async () => {
  const { dom, root, block, fetchCalls } = await setup({
    shopifyProductId: null, // no product id at all
    variantMap: { "1001": { sku: "REAL-A", available: true }, "1002": { sku: "", available: true } },
    variantId: "1001",
    variantSku: "REAL-A",
    catalogIdentity: () => null,
    calcIdentity: () => null,
  });
  await wait(80);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), true, "initial non-blank SKU, no product id — allowed");
  assert.equal(btn(root).disabled, false);

  // Switch to the BLANK-SKU variant 1002 — with no product id this must now fail closed,
  // even though the INITIAL variant had a real SKU.
  const sectionEl = dom.window.document.getElementById("shopify-section-sec1")!;
  const EventCtor = dom.window as unknown as { CustomEvent: typeof CustomEvent };
  const ev = new EventCtor.CustomEvent("shopify:product:select", { bubbles: true }) as CustomEvent & {
    product: { id: string }; selectedOptions: Record<string, string>; promise: Promise<unknown>;
  };
  ev.product = { id: PRODUCT_GID };
  ev.selectedOptions = {};
  ev.promise = Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } });
  sectionEl.dispatchEvent(ev);
  await wait(120);

  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "", "active SKU is now blank");
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false, "active blank SKU + no product id -> fail closed");
  assert.equal(btn(root).disabled, true);
  assert.equal(cartAdds(fetchCalls), 0);
});

test("14: a direct addToCart() cannot use a quote that was rejected for invalid identity", async () => {
  const { root, block, fetchCalls } = await setup({ calcIdentity: () => ({ resolutionSource: "sku" }) }); // malformed
  await wait(80);
  expectFailClosed(root, block, fetchCalls);
  // The quote is already cleared; a direct call must still not submit.
  (block as { addToCart: () => void }).addToCart();
  await wait(40);
  assert.equal(cartAdds(fetchCalls), 0);
});

test("15-adjacent: a valid identity that later mismatches the current selection is rejected on arrival", async () => {
  // First quote is valid (1001). Then the POST handler starts answering with a stale
  // identity for 1001 while the block has moved to 1002.
  let phase = 1;
  const { dom, block, fetchCalls } = await setup({
    variantMap: { "1001": { sku: "", available: true }, "1002": { sku: "", available: true } },
    calcIdentity: (pid) => (phase === 1
      ? { shopifyProductId: pid, shopifyVariantId: "1001", resolutionSource: "product_override" }
      : { shopifyProductId: pid, shopifyVariantId: "1001", resolutionSource: "product_override" }),
  });
  await wait(80);
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1001");
  phase = 2;

  const sectionEl = dom.window.document.getElementById("shopify-section-sec1")!;
  const EventCtor = dom.window as unknown as { CustomEvent: typeof CustomEvent };
  const ev = new EventCtor.CustomEvent("shopify:product:select", { bubbles: true }) as CustomEvent & {
    product: { id: string }; selectedOptions: Record<string, string>; promise: Promise<unknown>;
  };
  ev.product = { id: PRODUCT_GID };
  ev.selectedOptions = {};
  ev.promise = Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } });
  sectionEl.dispatchEvent(ev);
  await wait(400);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  assert.equal((block as { quotedVariantId: unknown }).quotedVariantId, null, "the stale-identity response was not adopted for 1002");
  assert.equal(cartAdds(fetchCalls), 0);
});
