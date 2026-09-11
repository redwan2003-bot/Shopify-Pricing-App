/**
 * Task 4A.5.2 — FAIL-CLOSED NATIVE CONTAINMENT.
 *
 * Enforcement intent (the ImprintID block is present + a valid Shopify product id) is
 * decoupled from variant-metadata validity. When the variant map is missing / blank /
 * malformed / `{}` / inconsistent, when the initial variant is absent, when the variant
 * id is invalid, when the only variant is unavailable, or when section synchronization
 * fails after ownership was established — dynamic PRICING fails closed, but the native
 * Shopify Add to Cart (main + sticky) STAYS contained. Unrelated forms are untouched.
 *
 * Genuine execution tests (real jsdom, real `PricingBlock`, mocked `fetch`).
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

interface FetchCall {
  url: string;
  method: string;
}

function pricingRootHtml(attrs: Record<string, string | null>) {
  const attrString = Object.entries(attrs)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`)
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
            <select data-imprintid-pricing-colors><option value="1">1</option></select>
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
  /** raw `data-variant-map` value; `null` omits the attribute entirely. */
  variantMap: string | null;
  variantId?: string;
  shopifyProductId?: string | null;
}

async function setup(options: SetupOptions) {
  const rootAttrs: Record<string, string | null> = {
    "data-sku": "",
    "data-variant-id": options.variantId ?? "1001",
    "data-variant-sku": "",
    "data-variant-available": "true",
    "data-product-gid": PRODUCT_GID,
    "data-shopify-product-id": options.shopifyProductId === undefined ? PRODUCT_ID : options.shopifyProductId,
    "data-section-id": "sec1",
    "data-variant-map": options.variantMap,
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main>
      <div data-section-id="sec1" id="shopify-section-sec1">
        <variant-picker data-product-id="${PRODUCT_ID}"><fieldset>
          <input type="radio" name="opt" value="black" data-variant-id="1001" checked>
          <input type="radio" name="opt" value="red" data-variant-id="1002">
        </fieldset></variant-picker>
        <product-form>
          <form id="pf-sec1" data-type="add-to-cart-form" action="/cart/add">
            <input type="hidden" name="id" value="${options.variantId ?? "1001"}">
            <button type="submit" name="add" data-native-main>Add to cart</button>
          </form>
        </product-form>
        <sticky-buy-buttons><button type="submit" name="add" form="pf-sec1" data-native-sticky>Add</button></sticky-buy-buttons>
        ${pricingRootHtml(rootAttrs)}
      </div>
      <div data-section-id="recs" id="shopify-section-recs">
        <product-form><form id="pf-recs" action="/cart/add"><input type="hidden" name="id" value="222222"><button type="submit" name="add" data-recs-add>Add</button></form></product-form>
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
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), method: (init?.method as string) || "GET" });
    return { ok: true, status: 200, json: async () => ({ ok: false, error: { code: "PRICING_PROFILE_NOT_FOUND" } }) } as Response;
  }) as typeof fetch;
  (globalThis as unknown as { AbortController: typeof AbortController }).AbortController = w.AbortController;
  (globalThis as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = w.CustomEvent;

  await import(`../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js?t=${Date.now()}-${Math.random()}`);
  const root = w.document.querySelector("[data-imprintid-pricing-test-root]")!;
  root.removeAttribute("data-imprintid-pricing-test-root");
  root.setAttribute("data-imprintid-pricing", "");
  const ImprintIdPricing = (w as unknown as { ImprintIdPricing: { PricingBlock: new (r: Element) => unknown } }).ImprintIdPricing;
  const block = new ImprintIdPricing.PricingBlock(root) as Record<string, unknown>;
  return { dom, w, root, block, fetchCalls };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (dom: JSDOM, sel: string) => dom.window.document.querySelector(sel) as HTMLElement;
const contained = (el: Element | null) => !!el && el.getAttribute("data-imprintid-contained") === "1";
const cartAdds = (c: FetchCall[]) => c.filter((x) => x.url.includes("/cart/add.js")).length;

function assertContainedAndPricingClosed(dom: JSDOM, root: Element, block: Record<string, unknown>, fetchCalls: FetchCall[]) {
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  const sticky = q(dom, "[data-native-sticky]") as HTMLButtonElement;
  assert.equal(main.disabled, true, "native main disabled");
  assert.equal(main.getAttribute("aria-disabled"), "true");
  assert.ok(contained(main), "native main contained");
  assert.equal(sticky.disabled, true, "native sticky disabled");
  assert.ok(contained(sticky), "native sticky contained");
  assert.equal(root.getAttribute("data-imprintid-native-contained"), "true");
  assert.equal((root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement).disabled, true, "ImprintID button disabled");
  assert.equal((block as { cartPricing: unknown }).cartPricing, null, "no signed quote");
  assert.equal(cartAdds(fetchCalls), 0);
  // unrelated section form never touched
  const recs = q(dom, "[data-recs-add]") as HTMLButtonElement;
  assert.equal(contained(recs), false, "unrelated section form not contained");
  assert.equal(recs.disabled, false);
}

// ============================================================================

test("4A.5.2-1: variant-map ATTRIBUTE MISSING → pricing fails closed, native cart stays contained", async () => {
  const { dom, root, block, fetchCalls } = await setup({ variantMap: null });
  await wait(90);
  assertContainedAndPricingClosed(dom, root, block, fetchCalls);
});

test("4A.5.2-2: variant-map BLANK string → contained", async () => {
  const { dom, root, block, fetchCalls } = await setup({ variantMap: "   " });
  await wait(90);
  assertContainedAndPricingClosed(dom, root, block, fetchCalls);
});

test("4A.5.2-3: variant-map MALFORMED JSON → contained", async () => {
  const { dom, root, block, fetchCalls } = await setup({ variantMap: "{ not json " });
  await wait(90);
  assertContainedAndPricingClosed(dom, root, block, fetchCalls);
});

test("4A.5.2-4: variant-map is {} (no entries) → contained", async () => {
  const { dom, root, block, fetchCalls } = await setup({ variantMap: "{}" });
  await wait(90);
  assertContainedAndPricingClosed(dom, root, block, fetchCalls);
});

test("4A.5.2-5: initial variant absent from the map → contained", async () => {
  const { dom, root, block, fetchCalls } = await setup({
    variantMap: JSON.stringify({ "2002": { sku: "", available: true } }),
    variantId: "1001",
  });
  await wait(90);
  assertContainedAndPricingClosed(dom, root, block, fetchCalls);
});

test("4A.5.2-6: variant id invalid (non-digit data-variant-id) → contained", async () => {
  const { dom, root, block, fetchCalls } = await setup({
    variantMap: JSON.stringify({ "1001": { sku: "", available: true }, "1002": { sku: "", available: true } }),
    variantId: "not-a-number",
  });
  await wait(90);
  assertContainedAndPricingClosed(dom, root, block, fetchCalls);
});

test("4A.5.2-7: inconsistent map (a non-boolean `available`) → contained", async () => {
  const { dom, root, block, fetchCalls } = await setup({
    variantMap: '{"1001":{"sku":"","available":"yes"}}',
  });
  await wait(90);
  assertContainedAndPricingClosed(dom, root, block, fetchCalls);
});

test("4A.5.2-8: the single mapped variant is unavailable → contained", async () => {
  const { dom, root, block, fetchCalls } = await setup({
    variantMap: JSON.stringify({ "1001": { sku: "", available: false } }),
  });
  await wait(90);
  assertContainedAndPricingClosed(dom, root, block, fetchCalls);
});

test("4A.5.2-9: section synchronization fails AFTER ownership was established → native cart stays contained", async () => {
  // valid metadata → ownership established → then the owning <product-form> and hidden
  // input are removed from the section (Horizon re-render that drops the picker/form).
  const { dom, root, block, fetchCalls } = await setup({
    variantMap: JSON.stringify({ "1001": { sku: "", available: true }, "1002": { sku: "", available: true } }),
  });
  await wait(90);
  assert.ok(contained(q(dom, "[data-native-main]")), "sanity: contained after init");

  // Remove the authoritative hidden variant input — the block can no longer reconcile
  // the selected variant (sync is lost), but the native form + buttons remain. It must
  // NOT drop containment.
  dom.window.document.querySelector('#pf-sec1 input[name="id"]')!.remove();
  await wait(120);

  assert.ok(contained(q(dom, "[data-native-main]")), "native main STILL contained after sync loss");
  assert.ok(contained(q(dom, "[data-native-sticky]")), "native sticky STILL contained after sync loss");
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, true);
  assert.equal(cartAdds(fetchCalls), 0);
  void root;
  void block;
});

test("4A.5.2-10: NO enforcement intent (no valid Shopify product id) → native cart is NOT contained", async () => {
  const { dom, root } = await setup({ variantMap: "{}", shopifyProductId: null });
  await wait(90);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  assert.equal(contained(main), false, "no product id ⇒ no enforcement intent ⇒ native cart left alone");
  assert.equal(main.disabled, false);
  assert.equal(root.getAttribute("data-imprintid-native-contained"), null);
});

test("4A.5.2-11: containment holds through a pricing/catalog error response", async () => {
  const { dom, root, block, fetchCalls } = await setup({
    variantMap: JSON.stringify({ "1001": { sku: "", available: true }, "1002": { sku: "", available: true } }),
  });
  await wait(120); // fetch mock always returns { ok:false } → catalog error
  assert.ok(contained(q(dom, "[data-native-main]")), "contained despite the catalog error");
  assert.equal((root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement).disabled, true);
  void block;
  void fetchCalls;
});
