/**
 * Task 5B.3A — BROWSER v2 QUOTE OWNERSHIP.
 *
 * The storefront treats the returned v2 attributes as OPAQUE: it stores them only with
 * the quote that produced them, clears them on any product / variant / quantity /
 * configuration change and on an aborted/failed request, rejects a response from an
 * older ownership generation, requires the COMPLETE v2 payload (+ unexpired + owning)
 * before enabling Add to Cart, submits the four attributes UNCHANGED, never constructs /
 * edits / re-signs / submits v1.
 *
 * Genuine execution tests (real jsdom, real `PricingBlock`, mocked `fetch`). LNY01 is
 * modelled as three blank-SKU variants priced via a product-id override.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const PRODUCT_GID = "gid://shopify/Product/9442404663548";
const PRODUCT_ID = "9442404663548";
const ADJ_GID = "gid://shopify/ProductVariant/424242";

const LOCALE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../extensions/imprintid-dynamic-pricing/locales/en.default.json", import.meta.url)), "utf8"),
) as { dynamic_pricing: Record<string, string> };
const STRINGS: Record<string, string> = Object.fromEntries(
  Object.entries(LOCALE.dynamic_pricing).map(([k, v]) => ["dynamic_pricing." + k, v]),
);

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

const OVERRIDE_ID = (pid: string, vid: string) => ({ shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "product_override" });
const LNY01_MAP = {
  "1001": { sku: "", available: true },
  "1002": { sku: "", available: true },
  "1003": { sku: "", available: true },
};

const ISSUED_AT = 1_700_000_000;

/** A complete, structurally-valid v2 payload — no real signature needed (the browser
 * never verifies signatures; the Function does). */
function v2Payload(over: Record<string, unknown> = {}) {
  const quantity = (over.quantity as number) ?? 100;
  return {
    v: 2,
    installBinding: "install-binding-5b3a",
    productGid: PRODUCT_GID,
    variantGid: `gid://shopify/ProductVariant/1001`,
    quantity,
    currency: "USD",
    baseUnitPriceCents: 137,
    perUnitSurchargeCents: 0,
    flatSurchargeCents: 0,
    lineTotalCents: 137 * quantity,
    adjustmentVariantGid: ADJ_GID,
    profileRef: "prof_LNY01",
    profileRevision: 21,
    policyRevision: 9,
    configDigest: "sha256:abc",
    quoteId: "q-" + Math.random().toString(36).slice(2),
    issuedAtServer: ISSUED_AT,
    ...over,
  };
}
function v2CartPricing(payloadOver: Record<string, unknown> = {}) {
  return { version: 2, payload: JSON.stringify(v2Payload(payloadOver)), signature: "deadbeefsig", config: '{"quantity":' + ((payloadOver.quantity as number) ?? 100) + "}" };
}

function catalogBody(identity: unknown) {
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
function calcBody(identity: unknown, quantity: number, variantNumeric: string, cartPricing: unknown) {
  return {
    ok: true,
    data: {
      quantity,
      quantityTier: { id: "t1", minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 },
      availableQuantityTiers: [],
      base: { quantity, listUnitPriceCents: 229, netUnitPriceCents: 137, listSubtotalCents: 22900, netSubtotalCents: 137 * quantity },
      productColor: null, decoration: null, options: { selections: [], chargesCents: 0 },
      production: { code: "STD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null },
      packaging: null, totals: { listTotalCents: 22900, netTotalCents: 137 * quantity },
      cartPricing, identity,
    },
  };
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
            <select data-imprintid-pricing-locations><option value="1">1</option></select>
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
  /** override the cartPricing returned by the POST, given the request (numeric variant id + quantity). */
  cartPricingFor?: (variantNumeric: string, quantity: number) => unknown;
}

async function setup(options: SetupOptions = {}) {
  const rootAttrs: Record<string, string> = {
    "data-sku": "",
    "data-variant-id": "1001",
    "data-variant-sku": "",
    "data-variant-available": "true",
    "data-product-gid": PRODUCT_GID,
    "data-shopify-product-id": PRODUCT_ID,
    "data-section-id": "sec1",
    "data-variant-map": JSON.stringify(LNY01_MAP),
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main>
      <div data-section-id="sec1" id="shopify-section-sec1">
        <variant-picker data-product-id="${PRODUCT_ID}"><fieldset>
          <input type="radio" name="opt" value="black" data-variant-id="1001" checked>
          <input type="radio" name="opt" value="red" data-variant-id="1002">
          <input type="radio" name="opt" value="blue" data-variant-id="1003">
        </fieldset></variant-picker>
        <product-form><form id="pf-sec1" data-type="add-to-cart-form" action="/cart/add"><input type="hidden" name="id" value="1001"><button type="submit" name="add" data-native-main>Add</button></form></product-form>
        ${pricingRootHtml(rootAttrs)}
      </div>
    </main></body></html>`,
    { url: "https://example-shop.myshopify.com/products/x", runScripts: "outside-only" },
  );
  const w = dom.window;
  (globalThis as unknown as { window: typeof w }).window = w;
  globalThis.document = w.document as unknown as Document;
  (w as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };
  (globalThis as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };

  const fetchCalls: FetchCall[] = [];
  const cartPricingFor = options.cartPricingFor ?? ((vid: string, qty: number) => v2CartPricing({ variantGid: `gid://shopify/ProductVariant/${vid}`, quantity: qty }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method as string) || "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    fetchCalls.push({ url, method, body });
    let payload: unknown;
    if (url.includes("/cart/add.js")) payload = { items: [] };
    else if (method === "GET") {
      const u = new URL(url, "https://x.test");
      payload = catalogBody(OVERRIDE_ID(u.searchParams.get("shopifyProductId") ?? "", u.searchParams.get("shopifyVariantId") ?? ""));
    } else {
      const vid = String(body?.shopifyVariantId ?? "");
      const qty = Number(body?.quantity ?? 0);
      payload = calcBody(OVERRIDE_ID(String(body?.shopifyProductId ?? ""), vid), qty, vid, cartPricingFor(vid, qty));
    }
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = w.AbortController;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = w.CustomEvent;

  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);
  const root = w.document.querySelector("[data-imprintid-pricing-test-root]")!;
  root.removeAttribute("data-imprintid-pricing-test-root");
  root.setAttribute("data-imprintid-pricing", "");
  const ImprintIdPricing = (w as unknown as { ImprintIdPricing: { PricingBlock: new (r: Element) => unknown } }).ImprintIdPricing;
  const block = new ImprintIdPricing.PricingBlock(root) as Record<string, unknown>;
  // freeze "now" just after the quote's issue time so quotes are fresh unless a test moves it
  (block as { _now: () => number })._now = () => ISSUED_AT + 5;
  return { dom, w, root, block, fetchCalls };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (dom: JSDOM, sel: string) => dom.window.document.querySelector(sel) as HTMLElement;
const btn = (root: Element) => root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
const cartAdds = (c: FetchCall[]) => c.filter((x) => x.url.includes("/cart/add.js"));
const hidden = (dom: JSDOM) => dom.window.document.querySelector('#pf-sec1 input[name="id"]') as HTMLInputElement;

function horizonSelect(dom: JSDOM, variantId: string) {
  hidden(dom).value = variantId;
  const radio = dom.window.document.querySelector(`variant-picker input[data-variant-id="${variantId}"]`) as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("change", { bubbles: true }));
}
function setQty(dom: JSDOM, n: number) {
  const el = q(dom, "[data-imprintid-pricing-quantity]") as HTMLInputElement;
  el.value = String(n);
  el.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
}

// ============================================================================

test("5B.3A-1: a complete owning v2 quote enables Add to Cart; the click POSTs exactly the four v2 attributes unchanged", async () => {
  const { dom, root, block, fetchCalls } = await setup();
  await wait(90);
  assert.equal(btn(root).disabled, false, "enabled by a complete v2 quote");
  assert.equal((block as { quotedQuantity: number }).quotedQuantity, 100);

  const held = JSON.parse((block as { cartPricing: { payload: string } }).cartPricing.payload);
  btn(root).dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
  await wait(50);

  const add = cartAdds(fetchCalls)[0];
  assert.ok(add, "POSTed to /cart/add.js");
  const props = (add.body as { items: Array<{ properties: Record<string, string> }> }).items[0]!.properties;
  assert.deepEqual(Object.keys(props).sort(), [
    "_imprintid_pricing_config",
    "_imprintid_pricing_payload",
    "_imprintid_pricing_signature",
    "_imprintid_pricing_version",
  ]);
  assert.equal(props._imprintid_pricing_version, "2");
  assert.equal(props._imprintid_pricing_payload, (block as { cartPricing: { payload: string } }).cartPricing.payload, "payload submitted unchanged");
  assert.equal(props._imprintid_pricing_signature, "deadbeefsig");
  assert.equal(JSON.parse(props._imprintid_pricing_payload).quoteId, held.quoteId, "same quote, never re-built");
});

test("5B.3A-2: a `version:1` envelope carrying a v2-shaped payload is rejected — never re-labelled / submitted as v1 (no downgrade)", async () => {
  const { root, block, fetchCalls } = await setup({
    cartPricingFor: (vid, qty) => ({
      version: 1, // claims v1 …
      payload: JSON.stringify(v2Payload({ variantGid: `gid://shopify/ProductVariant/${vid}`, quantity: qty })), // … but the body is v2
      signature: "sig",
    }),
  });
  await wait(90);
  assert.equal(btn(root).disabled, true, "a v1-labelled v2 payload never becomes cart-ready");
  assert.equal((block as { cartPricing: unknown }).cartPricing, null);
  (block as { addToCart: () => void }).addToCart();
  await wait(40);
  assert.equal(cartAdds(fetchCalls).length, 0, "never POSTs — no downgrade path");
});

test("5B.3A-3: an INCOMPLETE v2 payload (missing a field) is rejected — button stays disabled, no request", async () => {
  const { root, block, fetchCalls } = await setup({
    cartPricingFor: (vid, qty) => {
      const p = v2Payload({ variantGid: `gid://shopify/ProductVariant/${vid}`, quantity: qty }) as Record<string, unknown>;
      delete p.policyRevision;
      return { version: 2, payload: JSON.stringify(p), signature: "s", config: "{}" };
    },
  });
  await wait(90);
  assert.equal(btn(root).disabled, true);
  assert.equal((block as { cartPricing: unknown }).cartPricing, null);
  (block as { addToCart: () => void }).addToCart();
  await wait(40);
  assert.equal(cartAdds(fetchCalls).length, 0);
});

test("5B.3A-4: a variant change clears the held v2 attributes before any new quote lands", async () => {
  let release: () => void = () => {};
  const { dom, root, block } = await setup();
  await wait(90);
  assert.ok((block as { cartPricing: unknown }).cartPricing, "held after initial quote");

  // hang the NEXT pricing POST so we can observe the window after the change, before the new quote
  const realFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
  let first = true;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (i: unknown, init?: RequestInit) => {
    if (((init?.method as string) || "GET") === "POST" && first) {
      first = false;
      await new Promise<void>((r) => { release = r; });
    }
    return realFetch(i as string, init);
  }) as typeof fetch;

  horizonSelect(dom, "1002");
  await wait(60);
  assert.equal((block as { cartPricing: unknown }).cartPricing, null, "cleared on variant change — before the new quote arrives");
  assert.equal((block as { quotedQuantity: unknown }).quotedQuantity, null);
  assert.equal((block as { quotedVariantId: unknown }).quotedVariantId, null);
  assert.equal(btn(root).disabled, true);

  release();
  await wait(120);
  assert.equal(btn(root).disabled, false, "re-enabled once the new owning v2 quote lands");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1002");
});

test("5B.3A-5: a quantity change clears the held v2 attributes synchronously", async () => {
  const { dom, root, block } = await setup();
  await wait(90);
  setQty(dom, 150);
  assert.equal((block as { cartPricing: unknown }).cartPricing, null, "cleared synchronously on quantity change");
  assert.equal(btn(root).disabled, true);
  await wait(400);
  assert.equal((block as { quotedQuantity: number }).quotedQuantity, 150, "re-quoted for the new quantity");
  assert.equal(btn(root).disabled, false);
});

test("5B.3A-6: a configuration change clears the held v2 attributes synchronously", async () => {
  const { dom, root, block } = await setup();
  await wait(90);
  const colors = q(dom, "[data-imprintid-pricing-colors]") as unknown as HTMLSelectElement;
  colors.value = "2";
  colors.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("change", { bubbles: true }));
  assert.equal((block as { cartPricing: unknown }).cartPricing, null, "cleared synchronously on config change");
  assert.equal(btn(root).disabled, true);
});

test("5B.3A-7: a stale response (older config generation) cannot restore the attributes", async () => {
  let release: () => void = () => {};
  const { dom, block } = await setup();
  await wait(90);

  const realFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
  let first = true;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (i: unknown, init?: RequestInit) => {
    const method = (init?.method as string) || "GET";
    if (method === "POST" && first) {
      first = false;
      await new Promise<void>((r) => {
        release = r;
      });
    }
    return realFetch(i as string, init);
  }) as typeof fetch;

  setQty(dom, 150);
  await wait(360); // past the 300ms debounce — POST #1 fires and hangs
  setQty(dom, 175);
  await wait(360); // POST #2 fires and completes (only the FIRST post hangs), renders qty-175
  release(); // now release the stale qty-150 POST #1
  await wait(120);

  assert.equal((block as { quotedQuantity: number }).quotedQuantity, 175, "only the newest quote's ownership stands");
  const held = (block as { cartPricing: { payload: string } | null }).cartPricing;
  assert.ok(held, "a quote is held (the qty-175 one)");
  assert.equal(JSON.parse(held!.payload).quantity, 175, "the stale qty-150 response never restored the attributes");
});

test("5B.3A-8: direct addToCart() with NO held quote performs no request", async () => {
  const { block, fetchCalls } = await setup({ cartPricingFor: () => null });
  await wait(90);
  assert.equal((block as { cartPricing: unknown }).cartPricing, null);
  (block as { addToCart: () => void }).addToCart();
  await wait(40);
  assert.equal(cartAdds(fetchCalls).length, 0);
});

test("5B.3A-9: an EXPIRED v2 quote fails closed on Add to Cart (no request)", async () => {
  const { root, block, fetchCalls } = await setup();
  await wait(90);
  assert.equal(btn(root).disabled, false, "sanity: fresh quote enabled");
  // move the clock past issue + TTL
  (block as { _now: () => number })._now = () => ISSUED_AT + 30 * 60 + 10;
  (block as { addToCart: () => void }).addToCart();
  await wait(40);
  assert.equal(cartAdds(fetchCalls).length, 0, "expired quote never POSTs /cart/add.js");
});

test("5B.3A-10: a v2 quote bound to a DIFFERENT variant than requested is rejected on arrival", async () => {
  const { root, block } = await setup({
    // server (wrongly / staleley) returns a quote for 1002 while the request was for 1001
    cartPricingFor: (_vid, qty) => v2CartPricing({ variantGid: "gid://shopify/ProductVariant/1002", quantity: qty }),
  });
  await wait(90);
  assert.equal(btn(root).disabled, true, "mis-bound quote never becomes cart-ready");
  assert.equal((block as { cartPricing: unknown }).cartPricing, null);
});

test("5B.3A-11: blank-SKU LNY01 (product-id override) still produces a cart-ready v2 quote", async () => {
  const { root, block } = await setup();
  await wait(90);
  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "", "blank SKU");
  assert.equal((block as { catalogSku: string }).catalogSku, "", "catalogSku blank — not a blocker");
  assert.equal(btn(root).disabled, false, "v2 quote via product-id override is cart-ready");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1001");
});

test("5B.3A-12: malformed variant metadata → native cart stays contained even though v2 pricing failed closed", async () => {
  // rebuild with a broken variant map
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main><div data-section-id="sec1" id="shopify-section-sec1">
      <product-form><form id="pf-sec1" action="/cart/add"><input type="hidden" name="id" value="1001"><button type="submit" name="add" data-native-main>Add</button></form></product-form>
      ${pricingRootHtml({
        "data-sku": "", "data-variant-id": "1001", "data-variant-sku": "", "data-variant-available": "true",
        "data-product-gid": PRODUCT_GID, "data-shopify-product-id": PRODUCT_ID, "data-section-id": "sec1",
        "data-variant-map": "{ broken", "data-proxy-path": "/apps/imprintid-pricing/pricing", "data-show-breakdown": "false",
      })}
    </div></main></body></html>`,
    { url: "https://x.myshopify.com/products/x", runScripts: "outside-only" },
  );
  const w = dom.window;
  (globalThis as unknown as { window: typeof w }).window = w;
  globalThis.document = w.document as unknown as Document;
  (globalThis as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };
  (w as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };
  const fetchCalls: FetchCall[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }) as Response) as typeof fetch;
  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = w.AbortController;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = w.CustomEvent;
  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);
  const root = w.document.querySelector("[data-imprintid-pricing-test-root]")!;
  root.removeAttribute("data-imprintid-pricing-test-root");
  root.setAttribute("data-imprintid-pricing", "");
  const ImprintIdPricing = (w as unknown as { ImprintIdPricing: { PricingBlock: new (r: Element) => unknown } }).ImprintIdPricing;
  const block = new ImprintIdPricing.PricingBlock(root) as Record<string, unknown>;
  await wait(90);

  assert.equal((block as { cartPricing: unknown }).cartPricing, null, "v2 pricing failed closed");
  assert.equal(btn(root).disabled, true);
  assert.equal((w.document.querySelector("[data-native-main]") as HTMLButtonElement).disabled, true, "native cart still contained");
  assert.equal(w.document.querySelector("[data-native-main]")!.getAttribute("data-imprintid-contained"), "1");
  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0);
});
