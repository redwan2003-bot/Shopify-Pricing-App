/**
 * Task 4A.5 — HORIZON VARIANT SYNCHRONIZATION AND NATIVE CART CONTAINMENT.
 *
 * Genuine execution tests (real jsdom DOM, real `PricingBlock`, mocked `fetch`). The
 * section is built the way Horizon renders a product page: a `<variant-picker>` of
 * radio controls plus a sibling `<product-form>` whose hidden `input[name="id"]` is the
 * authoritative variant field. Horizon updates are simulated faithfully — a native
 * `change` on the chosen radio, the hidden input's value moving, and (for the
 * section-render path) the hidden input node being replaced.
 *
 * Confirmed defect being closed: switching the real Shopify variant left the ImprintID
 * block pricing the previously rendered variant, issued no new request, and kept the
 * stale quote addable. No hard-coded color name; no real store id.
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
const SYNC_ERROR = STRINGS["dynamic_pricing.variant_sync_error"]!;
const UNAVAILABLE = STRINGS["dynamic_pricing.variant_unavailable"]!;

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

const OVERRIDE_ID = (pid: string, vid: string) => ({ shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "product_override" });

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
function calcBody(identity: unknown) {
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

/** Horizon-style `<variant-picker>` — a fieldset of radio controls per option. */
function variantPickerHtml(opts: { productId?: string; selected: string; ids: Record<string, string> }) {
  const pid = opts.productId === undefined ? ` data-product-id="${PRODUCT_ID}"` : opts.productId ? ` data-product-id="${opts.productId}"` : "";
  const radios = Object.entries(opts.ids)
    .map(
      ([label, vid]) =>
        `<input type="radio" name="option-color" value="${label}" data-variant-id="${vid}"${vid === opts.ids[opts.selected] ? " checked" : ""}>`,
    )
    .join("");
  return `<variant-picker${pid}><fieldset>${radios}</fieldset></variant-picker>`;
}

function productFormHtml(variantId: string) {
  return `<product-form><form data-type="add-to-cart-form" action="/cart/add"><input type="hidden" name="id" value="${variantId}"><button type="submit">Add</button></form></product-form>`;
}

interface SetupOptions {
  variantMap?: Record<string, { sku: string; available: boolean }>;
  variantId?: string;
  extraSectionHtml?: string;
  pickerProductId?: string; // "" omits data-product-id
  secondPicker?: string; // raw HTML for a rival <variant-picker>
  calcIdentity?: (pid: string, vid: string) => unknown;
  catalogIdentity?: (pid: string, vid: string) => unknown;
}

const DEFAULT_MAP = {
  "1001": { sku: "", available: true },
  "1002": { sku: "", available: true },
  "1003": { sku: "", available: true },
};

async function setup(options: SetupOptions = {}) {
  const map = options.variantMap ?? DEFAULT_MAP;
  const variantId = options.variantId ?? "1001";
  const catId = options.catalogIdentity ?? OVERRIDE_ID;
  const calcId = options.calcIdentity ?? OVERRIDE_ID;

  const rootAttrs: Record<string, string> = {
    "data-sku": "",
    "data-variant-id": variantId,
    "data-variant-sku": "",
    "data-variant-available": "true",
    "data-product-gid": PRODUCT_GID,
    "data-shopify-product-id": PRODUCT_ID,
    "data-section-id": "sec1",
    "data-variant-map": JSON.stringify(map),
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };

  const picker = variantPickerHtml({
    productId: options.pickerProductId,
    selected: "black",
    ids: { black: "1001", red: "1002", blue: "1003" },
  });

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div data-section-id="sec1" id="shopify-section-sec1">
        ${picker}
        ${options.secondPicker ?? ""}
        ${productFormHtml(variantId)}
        ${options.extraSectionHtml ?? ""}
        ${pricingRootHtml(rootAttrs)}
      </div>
    </body></html>`,
    { url: "https://example-shop.myshopify.com/products/x", runScripts: "outside-only" },
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
    if (url.includes("/cart/add.js")) {
      payload = { items: [] };
    } else if (method === "GET") {
      const u = new URL(url, "https://x.test");
      payload = catalogBody(catId(u.searchParams.get("shopifyProductId") ?? "", u.searchParams.get("shopifyVariantId") ?? ""));
    } else {
      payload = calcBody(calcId(String(body?.shopifyProductId ?? ""), String(body?.shopifyVariantId ?? "")));
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
const unavailText = (root: Element) => (root.querySelector("[data-imprintid-pricing-unavailable]") as HTMLElement).textContent;
const posts = (c: FetchCall[]) => c.filter((x) => x.method === "POST" && x.url.includes("pricing"));
const gets = (c: FetchCall[]) => c.filter((x) => x.method === "GET" && x.url.includes("pricing"));
const cartAdds = (c: FetchCall[]) => c.filter((x) => x.url.includes("/cart/add.js")).length;

function hiddenInput(dom: JSDOM) {
  return dom.window.document.querySelector('product-form input[name="id"]') as HTMLInputElement;
}
function picker(dom: JSDOM) {
  return dom.window.document.querySelector("variant-picker") as Element;
}

/** Faithful simulation of a Horizon variant switch: the theme moves its own hidden
 * field, then the radio fires a native bubbling `change`. */
function horizonSelect(dom: JSDOM, variantId: string) {
  hiddenInput(dom).value = variantId;
  const p = picker(dom);
  const radio = p.querySelector(`input[data-variant-id="${variantId}"]`) as HTMLInputElement;
  radio.checked = true;
  const Ev = dom.window as unknown as { Event: typeof Event };
  radio.dispatchEvent(new Ev.Event("change", { bubbles: true }));
}

// ============================================================================

test("4A.5-1: a Horizon variant switch (Black→Red) is adopted — one pricing POST, no catalog GET, fresh quote owned by Red", async () => {
  const { dom, root, block, fetchCalls } = await setup();
  await wait(80);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1001");
  assert.equal(btn(root).disabled, false, "sanity: quoted for the initial variant");
  const postsBefore = posts(fetchCalls).length;
  const getsBefore = gets(fetchCalls).length;

  horizonSelect(dom, "1002");
  await wait(120);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002", "adopted the newly selected variant");
  assert.equal(posts(fetchCalls).length - postsBefore, 1, "exactly one fresh pricing POST for the new variant");
  assert.equal(gets(fetchCalls).length - getsBefore, 0, "no catalog GET — same SKU, existing catalog reusable");
  const lastPost = posts(fetchCalls).at(-1)!;
  assert.equal(lastPost.body!.shopifyVariantId, "1002");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1002", "the quote is owned by Red");
  assert.equal(btn(root).disabled, false, "Add to Cart re-enabled once the Red-owned quote lands");
});

test("4A.5-2: selecting the already-active variant produces no request", async () => {
  const { dom, fetchCalls } = await setup();
  await wait(80);
  const before = fetchCalls.length;

  horizonSelect(dom, "1001"); // already active
  await wait(120);

  assert.equal(fetchCalls.length, before, "no catalog GET and no pricing POST for a no-op selection");
});

test("4A.5-3: rapid Black→Red→Blue renders only the Blue quote", async () => {
  const seen: string[] = [];
  const { dom, root, block, fetchCalls } = await setup({
    calcIdentity: (pid, vid) => {
      seen.push(vid);
      return OVERRIDE_ID(pid, vid);
    },
  });
  await wait(80);

  horizonSelect(dom, "1002");
  horizonSelect(dom, "1003");
  horizonSelect(dom, "1002");
  horizonSelect(dom, "1003"); // final, stable selection: Blue
  await wait(200);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003", "final selection is Blue");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1003", "the rendered quote is owned by Blue");
  const lastPost = posts(fetchCalls).at(-1)!;
  assert.equal(lastPost.body!.shopifyVariantId, "1003");
  assert.equal(btn(root).disabled, false);
});

test("4A.5-4: an old in-flight response never renders after a newer variant selection", async () => {
  let release: () => void = () => {};
  const { dom, root, block } = await setup({
    calcIdentity: (pid, vid) => OVERRIDE_ID(pid, vid),
  });
  await wait(80);

  // Make the NEXT pricing POST hang, switch to Red, then release it AFTER switching to Blue.
  const realFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
  let firstAfter = true;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (i: unknown, init?: RequestInit) => {
    const method = (init?.method as string) || "GET";
    if (method === "POST" && firstAfter) {
      firstAfter = false;
      await new Promise<void>((r) => {
        release = r;
      });
    }
    return realFetch(i as string, init);
  }) as typeof fetch;

  horizonSelect(dom, "1002"); // Red — its POST will hang
  await wait(60);
  horizonSelect(dom, "1003"); // Blue — supersedes Red
  await wait(120);
  release(); // release the stale Red response now
  await wait(120);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1003", "the late Red response was discarded, not rendered");
  assert.equal(btn(root).disabled, false);
});

test("4A.5-5: adoption also works when only the hidden input node is replaced (section HTML re-render)", async () => {
  const { dom, block, fetchCalls } = await setup();
  await wait(80);
  const before = posts(fetchCalls).length;

  // Horizon re-renders the section: the <product-form> subtree is swapped for new HTML
  // whose hidden input already carries the new variant id — no `change` event at all.
  const pf = dom.window.document.querySelector("product-form")!;
  pf.outerHTML = '<product-form><form data-type="add-to-cart-form" action="/cart/add"><input type="hidden" name="id" value="1002"><button type="submit">Add</button></form></product-form>';
  await wait(120);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002", "reconciled against the replaced hidden input");
  assert.equal(posts(fetchCalls).length - before, 1, "exactly one fresh pricing POST");
});

test("4A.5-6: a selected variant absent from the trusted map fails closed — no request, Add to Cart disabled", async () => {
  const { dom, root, block, fetchCalls } = await setup();
  await wait(80);
  const before = fetchCalls.length;

  hiddenInput(dom).value = "9999"; // not in data-variant-map
  const Ev = dom.window as unknown as { Event: typeof Event };
  picker(dom).dispatchEvent(new Ev.Event("change", { bubbles: true }));
  await wait(120);

  assert.equal(posts(fetchCalls).length, posts(fetchCalls.slice(0, before)).length, "no pricing POST for an unmapped id");
  assert.equal(cartAdds(fetchCalls), 0);
  assert.equal(btn(root).disabled, true, "Add to Cart disabled");
  assert.equal(errText(root), UNAVAILABLE);
  assert.equal((block as { cartPricing: unknown }).cartPricing, null);
});

test("4A.5-7: two rival <variant-picker>s that can't be tied to this product fail closed with variant_sync_error", async () => {
  const { root, block, fetchCalls } = await setup({
    pickerProductId: "111111", // this block's own picker is for a different product id...
    secondPicker: '<variant-picker data-product-id="222222"><fieldset><input type="radio" name="c" value="a"></fieldset></variant-picker>',
  });
  await wait(80);

  assert.equal((block as { variantSyncUnavailable: boolean }).variantSyncUnavailable, true, "failed closed");
  assert.equal(unavailText(root), SYNC_ERROR);
  assert.equal(btn(root).disabled, true);
  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0);
});

test("4A.5-8: a quick-add form inside the section is never used as the variant controller", async () => {
  const { dom, block, fetchCalls } = await setup({
    // a recommendation card with its own product form for a DIFFERENT variant id
    extraSectionHtml:
      '<product-card class="product-card"><product-form><form data-type="add-to-cart-form"><input type="hidden" name="id" value="1003"></form></product-form></product-card>',
  });
  await wait(80);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1001", "did not adopt the card's variant id");
  assert.equal((block as { variantSyncUnavailable: boolean }).variantSyncUnavailable, false, "the card form is ignored, not treated as ambiguity");

  // The real product form still drives adoption.
  horizonSelect(dom, "1002");
  await wait(120);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  assert.equal(posts(fetchCalls).at(-1)!.body!.shopifyVariantId, "1002");
});

test("4A.5-9: after adoption, Add to Cart POSTs /cart/add.js for the newly selected variant only", async () => {
  const { dom, root, fetchCalls } = await setup();
  await wait(80);
  horizonSelect(dom, "1002");
  await wait(120);

  const Ev = dom.window as unknown as { Event: typeof Event };
  btn(root).dispatchEvent(new Ev.Event("click", { bubbles: true }));
  await wait(60);

  const add = fetchCalls.find((c) => c.url.includes("/cart/add.js"));
  assert.ok(add, "Add to Cart submitted");
  assert.equal((add!.body as { items: Array<{ id: string }> }).items[0]!.id, "1002", "added the adopted variant, never the initially rendered one");
});
