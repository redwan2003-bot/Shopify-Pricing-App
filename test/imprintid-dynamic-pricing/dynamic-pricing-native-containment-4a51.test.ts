/**
 * Task 4A.5.1 — COMPLETE NATIVE CART CONTAINMENT.
 *
 * Genuine execution tests (real jsdom DOM, real `PricingBlock`, mocked `fetch`). The
 * section is built the way Horizon renders a product page: a `<variant-picker>`, a
 * sibling `<product-form>` with a native `<button type="submit" name="add">`, a
 * `<sticky-buy-buttons>` bar (its button associated by `form="…"`), and the ImprintID
 * block. Also present: a separate recommendations section with its own product form,
 * and an in-section quick-add / product card — both must stay usable.
 *
 * No hard-coded color name; no real store id. LNY01 is modelled as three variants with
 * blank/null Shopify SKUs, a valid product id, and an active product-id pricing
 * override (`resolutionSource: "product_override"`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ASSET_PATH = fileURLToPath(
  new URL("../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing.js", import.meta.url),
);
const ASSET_SRC = readFileSync(ASSET_PATH, "utf8");

const PRODUCT_GID = "gid://shopify/Product/9442404663548";
const PRODUCT_ID = "9442404663548";

const LOCALE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../extensions/imprintid-dynamic-pricing/locales/en.default.json", import.meta.url)), "utf8"),
) as { dynamic_pricing: Record<string, string> };
const STRINGS: Record<string, string> = Object.fromEntries(
  Object.entries(LOCALE.dynamic_pricing).map(([k, v]) => ["dynamic_pricing." + k, v]),
);
const UNAVAILABLE = STRINGS["dynamic_pricing.variant_unavailable"]!;

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

const OVERRIDE_ID = (pid: string, vid: string) => ({ shopifyProductId: pid, shopifyVariantId: vid, resolutionSource: "product_override" });

/** LNY01-style: three variants, all blank SKU. */
const LNY01_MAP = {
  "1001": { sku: "", available: true },
  "1002": { sku: "", available: true },
  "1003": { sku: "", available: true },
};

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

function sectionHtml(opts: { sectionId: string; variantId: string; pickerProductId?: string }) {
  const sid = opts.sectionId;
  const rootAttrs: Record<string, string> = {
    "data-sku": "",
    "data-variant-id": opts.variantId,
    "data-variant-sku": "",
    "data-variant-available": "true",
    "data-product-gid": PRODUCT_GID,
    "data-shopify-product-id": PRODUCT_ID,
    "data-section-id": sid,
    "data-variant-map": JSON.stringify(LNY01_MAP),
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };
  const pid = opts.pickerProductId === undefined ? PRODUCT_ID : opts.pickerProductId;
  return `
    <div data-section-id="${sid}" id="shopify-section-${sid}">
      <variant-picker data-product-id="${pid}"><fieldset>
        <input type="radio" name="opt" value="black" data-variant-id="1001" checked>
        <input type="radio" name="opt" value="red" data-variant-id="1002">
        <input type="radio" name="opt" value="blue" data-variant-id="1003">
      </fieldset></variant-picker>
      <product-form>
        <form id="pf-${sid}" data-type="add-to-cart-form" action="/cart/add">
          <input type="hidden" name="id" value="${opts.variantId}">
          <button type="submit" name="add" data-native-main>Add to cart</button>
        </form>
      </product-form>
      <sticky-buy-buttons>
        <button type="submit" name="add" form="pf-${sid}" data-native-sticky>Add</button>
      </sticky-buy-buttons>
      <product-card class="product-card">
        <product-form><form id="qa-${sid}" action="/cart/add"><input type="hidden" name="id" value="9001"><button type="submit" name="add" data-quick-add>Quick add</button></form></product-form>
      </product-card>
      ${pricingRootHtml(rootAttrs)}
    </div>`;
}

/** A separate recommendations section for a DIFFERENT product — must stay usable. */
function recommendationsSectionHtml() {
  return `
    <div data-section-id="recs" id="shopify-section-recs">
      <product-form>
        <form id="pf-recs" data-type="add-to-cart-form" action="/cart/add">
          <input type="hidden" name="id" value="222222">
          <button type="submit" name="add" data-recs-add>Add</button>
        </form>
      </product-form>
    </div>`;
}

interface SetupOptions {
  variantId?: string;
  pickerProductId?: string;
  calcIdentity?: (pid: string, vid: string) => unknown;
}

async function setup(options: SetupOptions = {}) {
  const variantId = options.variantId ?? "1001";
  const calcId = options.calcIdentity ?? OVERRIDE_ID;

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <main>
        ${sectionHtml({ sectionId: "sec1", variantId, pickerProductId: options.pickerProductId })}
        ${recommendationsSectionHtml()}
      </main>
    </body></html>`,
    { url: "https://example-shop.myshopify.com/products/x", runScripts: "outside-only" },
  );
  const w = dom.window;
  (globalThis as unknown as { window: typeof w }).window = w;
  globalThis.document = w.document as unknown as Document;
  (w as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };
  (globalThis as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };

  const fetchCalls: FetchCall[] = [];
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
    } else payload = calcBody(calcId(String(body?.shopifyProductId ?? ""), String(body?.shopifyVariantId ?? "")));
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
  (root as unknown as { imprintIdPricingBlock: unknown }).imprintIdPricingBlock = block;
  return { dom, w, root, block, fetchCalls, ImprintIdPricing };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (dom: JSDOM, sel: string) => dom.window.document.querySelector(sel) as HTMLElement;
const contained = (el: Element | null) => !!el && el.getAttribute("data-imprintid-contained") === "1";
const posts = (c: FetchCall[]) => c.filter((x) => x.method === "POST" && x.url.includes("pricing"));
const cartAdds = (c: FetchCall[]) => c.filter((x) => x.url.includes("/cart/add.js")).length;
const hidden = (dom: JSDOM, sid = "sec1") => dom.window.document.querySelector(`#pf-${sid} input[name="id"]`) as HTMLInputElement;

function horizonSelect(dom: JSDOM, variantId: string, sid = "sec1") {
  hidden(dom, sid).value = variantId;
  const radio = dom.window.document.querySelector(`#shopify-section-${sid} variant-picker input[data-variant-id="${variantId}"]`) as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("change", { bubbles: true }));
}

// ============================================================================

test("4A.5.1-1: native main + sticky Add-to-Cart are disabled and aria-disabled; the ImprintID button is untouched", async () => {
  const { dom, root } = await setup();
  await wait(90);

  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  const sticky = q(dom, "[data-native-sticky]") as HTMLButtonElement;
  assert.equal(main.disabled, true, "native main disabled");
  assert.equal(main.getAttribute("aria-disabled"), "true");
  assert.ok(contained(main), "native main carries the containment marker");
  assert.equal(sticky.disabled, true, "native sticky disabled");
  assert.equal(sticky.getAttribute("aria-disabled"), "true");
  assert.ok(contained(sticky));
  assert.equal(root.getAttribute("data-imprintid-native-contained"), "true");

  const imprintBtn = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(contained(imprintBtn), false, "the ImprintID button is never contained");
});

test("4A.5.1-2: a native button click is neutralised by the capture-phase guard (no propagation, no cart request)", async () => {
  const { dom, fetchCalls } = await setup();
  await wait(90);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  const form = dom.window.document.getElementById("pf-sec1") as HTMLFormElement;
  // Model a theme that re-enables the button / relies on aria only: the containment
  // marker + capture guard must still stop the click cold.
  main.disabled = false;
  let sawClickAtDocument = false;
  let submitted = false;
  dom.window.document.addEventListener("click", () => { sawClickAtDocument = true; });
  form.addEventListener("submit", (e) => { if (!e.defaultPrevented) submitted = true; });

  main.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("click", { bubbles: true, cancelable: true }));
  await wait(30);

  assert.equal(sawClickAtDocument, false, "the click never propagated past the capture-phase guard");
  assert.equal(submitted, false, "no implicit form submission");
  assert.equal(cartAdds(fetchCalls), 0);
});

test("4A.5.1-3: the owning form submit is blocked, including via form.requestSubmit()", async () => {
  const { dom, fetchCalls } = await setup();
  await wait(90);
  const form = dom.window.document.getElementById("pf-sec1") as HTMLFormElement;
  assert.equal(form.getAttribute("data-imprintid-contained-form"), "1");

  let submitted = 0;
  const Ev = dom.window as unknown as { Event: typeof Event };
  form.addEventListener("submit", (e) => { if (!e.defaultPrevented) submitted++; });

  form.dispatchEvent(new Ev.Event("submit", { bubbles: true, cancelable: true }));
  if (typeof form.requestSubmit === "function") form.requestSubmit();
  await wait(30);

  assert.equal(submitted, 0, "no un-prevented submit reached the theme");
  assert.equal(cartAdds(fetchCalls), 0);
});

test("4A.5.1-4: a replaced native main button is contained again on the next tick", async () => {
  const { dom } = await setup();
  await wait(90);
  const form = dom.window.document.getElementById("pf-sec1")!;
  // Horizon swaps the button subtree for fresh, un-contained HTML.
  form.querySelector("[data-native-main]")!.outerHTML = '<button type="submit" name="add" data-native-main>Add to cart</button>';
  const fresh = q(dom, "[data-native-main]") as HTMLButtonElement;
  assert.equal(contained(fresh), false, "sanity: freshly inserted, not yet contained");
  await wait(60);
  assert.equal(contained(fresh), true, "re-contained after the mutation observer runs");
  assert.equal(fresh.disabled, true);
});

test("4A.5.1-5: a replaced <product-form> node rebinds variant sync and re-contains its button", async () => {
  const { dom, block, fetchCalls } = await setup();
  await wait(90);
  const before = posts(fetchCalls).length;

  const pf = dom.window.document.querySelector("#shopify-section-sec1 > product-form")!;
  pf.outerHTML =
    '<product-form><form id="pf-sec1" data-type="add-to-cart-form" action="/cart/add"><input type="hidden" name="id" value="1002"><button type="submit" name="add" data-native-main>Add</button></form></product-form>';
  await wait(120);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002", "reconciled against the replaced form's hidden input");
  assert.equal(posts(fetchCalls).length - before, 1, "exactly one fresh pricing POST");
  assert.equal(contained(q(dom, "[data-native-main]")), true, "the new form's button is contained");
});

test("4A.5.1-6: whole owning-section replacement destroys the old block and builds a fresh one", async () => {
  const { dom, block } = await setup();
  await wait(90);

  const oldSection = dom.window.document.getElementById("shopify-section-sec1")!;
  const replacement = dom.window.document.createElement("div");
  replacement.innerHTML = sectionHtml({ sectionId: "sec1", variantId: "1003" });
  const newSection = replacement.firstElementChild!;
  // the new section's block root must be live-init-able
  newSection.querySelector("[data-imprintid-pricing-test-root]")!.setAttribute("data-imprintid-pricing", "");
  newSection.querySelector("[data-imprintid-pricing]")!.removeAttribute("data-imprintid-pricing-test-root");
  oldSection.replaceWith(newSection);
  dom.window.document.dispatchEvent(
    new (dom.window as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent("shopify:section:load", { detail: { sectionId: "sec1" } }),
  );
  await wait(150);

  assert.equal((block as { destroyed: boolean }).destroyed, true, "old block torn down");
  const freshRoot = dom.window.document.querySelector("#shopify-section-sec1 [data-imprintid-pricing]") as unknown as { imprintIdPricingBlock?: { destroyed: boolean; selectedVariantId: string } };
  assert.ok(freshRoot.imprintIdPricingBlock, "a fresh block was constructed for the replacement section");
  assert.equal(freshRoot.imprintIdPricingBlock!.destroyed, false);
  await wait(80);
  assert.equal(contained(q(dom, "#shopify-section-sec1 [data-native-main]")), true, "native containment re-applied in the new section");
});

test("4A.5.1-7: after section replacement, the OLD block's observers no longer drive requests", async () => {
  const { dom, block, fetchCalls } = await setup();
  await wait(90);

  const oldSection = dom.window.document.getElementById("shopify-section-sec1")!;
  const detached = oldSection; // keep a reference after removal
  const replacement = dom.window.document.createElement("div");
  replacement.innerHTML = sectionHtml({ sectionId: "sec1", variantId: "1001" });
  const newSection = replacement.firstElementChild!;
  newSection.querySelector("[data-imprintid-pricing-test-root]")!.setAttribute("data-imprintid-pricing", "");
  newSection.querySelector("[data-imprintid-pricing]")!.removeAttribute("data-imprintid-pricing-test-root");
  oldSection.replaceWith(newSection);
  await wait(120);
  assert.equal((block as { destroyed: boolean }).destroyed, true);

  const countAfterSwap = fetchCalls.length;
  // Mutate the now-detached old section: nothing must happen.
  const oldInput = detached.querySelector('#pf-sec1 input[name="id"]') as HTMLInputElement;
  oldInput.value = "1002";
  detached.querySelector("variant-picker")!.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("change", { bubbles: true }));
  await wait(120);
  assert.equal(fetchCalls.length, countAfterSwap, "the destroyed block issued no further requests");
});

test("4A.5.1-8: repeated shopify:section:load events do not duplicate blocks or pricing requests", async () => {
  const { dom, root, fetchCalls } = await setup();
  await wait(90);
  const baseline = fetchCalls.length;

  for (let i = 0; i < 4; i++) {
    dom.window.document.dispatchEvent(
      new (dom.window as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent("shopify:section:load", { detail: { sectionId: "sec1" } }),
    );
  }
  await wait(150);

  assert.equal(fetchCalls.length, baseline, "no new catalog / pricing requests — same variant, same section");
  const roots = dom.window.document.querySelectorAll("#shopify-section-sec1 [data-imprintid-pricing]");
  assert.equal(roots.length, 1, "still exactly one ImprintID block in the section");
  assert.equal((root as unknown as { imprintIdPricingBlock: { destroyed: boolean } }).imprintIdPricingBlock.destroyed, false, "the live block survived (root never left the DOM)");
});

test("4A.5.1-9: a product form in a DIFFERENT section is never contained", async () => {
  const { dom } = await setup();
  await wait(90);
  const recsBtn = q(dom, "[data-recs-add]") as HTMLButtonElement;
  assert.equal(contained(recsBtn), false);
  assert.equal(recsBtn.disabled, false);
  assert.equal((dom.window.document.getElementById("pf-recs") as HTMLElement).getAttribute("data-imprintid-contained-form"), null);
});

test("4A.5.1-10: an in-section quick-add / product-card form stays usable", async () => {
  const { dom } = await setup();
  await wait(90);
  const qa = q(dom, "[data-quick-add]") as HTMLButtonElement;
  assert.equal(contained(qa), false, "quick-add button not contained");
  assert.equal(qa.disabled, false);
  assert.equal((dom.window.document.getElementById("qa-sec1") as HTMLElement).getAttribute("data-imprintid-contained-form"), null);
});

test("4A.5.1-11: the ImprintID addToCart() still performs its signed fetch when the quote is validly owned", async () => {
  const { root, block, fetchCalls } = await setup();
  await wait(90);
  assert.equal((root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement).disabled, false, "sanity: quoted");

  (block as { addToCart: () => void }).addToCart();
  await wait(50);
  const add = fetchCalls.find((c) => c.url.includes("/cart/add.js"));
  assert.ok(add, "ImprintID addToCart still reaches /cart/add.js");
  assert.equal((add!.body as { items: Array<{ id: string; properties: unknown }> }).items[0]!.id, "1001");
  assert.ok((add!.body as { items: Array<{ properties: Record<string, unknown> }> }).items[0]!.properties, "signed line properties attached");
});

test("4A.5.1-12: an unavailable selected variant clears pricing and keeps every owned cart control disabled", async () => {
  const { dom, root, block, fetchCalls } = await setup({
    // reuse LNY01 map but flip 1002 to unavailable via a fresh block
  });
  await wait(90);
  // Directly model an out-of-stock adoption: point the hidden input at an id the map marks unavailable.
  (block as { variantMap: Record<string, { sku: string; available: boolean }> }).variantMap["1002"] = { sku: "", available: false };
  horizonSelect(dom, "1002");
  await wait(120);

  assert.equal((block as { cartPricing: unknown }).cartPricing, null, "pricing cleared");
  assert.equal((root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement).disabled, true, "ImprintID button disabled");
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, true, "native main still disabled");
  assert.equal((q(dom, "[data-native-sticky]") as HTMLButtonElement).disabled, true, "native sticky still disabled");
  assert.equal(cartAdds(fetchCalls), 0);
});

test("4A.5.1-13: a missing / unmapped variant fails closed and keeps native controls disabled", async () => {
  const { dom, root, block, fetchCalls } = await setup();
  await wait(90);
  hidden(dom).value = "8888"; // absent from the map
  dom.window.document.querySelector("#shopify-section-sec1 variant-picker")!.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("change", { bubbles: true }));
  await wait(120);

  assert.equal((block as { cartPricing: unknown }).cartPricing, null);
  assert.equal((root.querySelector("[data-imprintid-pricing-error]") as HTMLElement).textContent, UNAVAILABLE);
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, true);
  assert.equal(cartAdds(fetchCalls), 0);
});

test("4A.5.1-14: blank-SKU LNY01 Black→Red→Blue works through the product-id override (catalogSku stays blank)", async () => {
  const seen: string[] = [];
  const { dom, block, fetchCalls } = await setup({
    calcIdentity: (pid, vid) => {
      seen.push(vid);
      return OVERRIDE_ID(pid, vid);
    },
  });
  await wait(90);

  horizonSelect(dom, "1002");
  await wait(120);
  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "", "still blank SKU");
  assert.equal((block as { catalogSku: string }).catalogSku, "", "catalogSku is blank, not a blocker");
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");

  horizonSelect(dom, "1003");
  await wait(120);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1003");
  const lastPost = posts(fetchCalls).at(-1)!;
  assert.equal(lastPost.body!.shopifyProductId, PRODUCT_ID);
  assert.equal(lastPost.body!.shopifyVariantId, "1003");
  assert.equal(posts(fetchCalls).filter((p) => (p.body as { shopifyVariantId: string }).shopifyVariantId === "1003").length >= 1, true);
});

test("4A.5.1-15: one stable Black→Red change = exactly one pricing POST; no catalog GET", async () => {
  const { dom, fetchCalls } = await setup();
  await wait(90);
  const postsBefore = posts(fetchCalls).length;
  const getsBefore = fetchCalls.filter((c) => c.method === "GET" && c.url.includes("pricing")).length;

  horizonSelect(dom, "1002");
  await wait(150);

  assert.equal(posts(fetchCalls).length - postsBefore, 1, "one pricing POST");
  assert.equal(fetchCalls.filter((c) => c.method === "GET" && c.url.includes("pricing")).length - getsBefore, 0, "no catalog GET (same SKU)");
});

test("4A.5.1-16: rapid Black→Red→Blue renders only the Blue quote", async () => {
  const { dom, root, block, fetchCalls } = await setup();
  await wait(90);
  horizonSelect(dom, "1002");
  horizonSelect(dom, "1003");
  horizonSelect(dom, "1002");
  horizonSelect(dom, "1003");
  await wait(200);
  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1003");
  assert.equal((block as { quotedVariantId: string }).quotedVariantId, "1003");
  assert.equal(posts(fetchCalls).at(-1)!.body!.shopifyVariantId, "1003");
  assert.equal((root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement).disabled, false);
});

test("4A.5.1-17: containment is applied even while pricing is still loading", async () => {
  const { dom } = await setup();
  // no wait — assert synchronously right after construction, before the catalog resolves
  await Promise.resolve();
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, true, "native main disabled during the loading state");
  assert.equal((q(dom, "[data-native-sticky]") as HTMLButtonElement).disabled, true);
});

test("4A.5.1-18: the module never patches a built-in prototype (no global form/DOM prototype patch)", async () => {
  // Strip comments — the doc comments legitimately *mention* "HTMLFormElement.prototype"
  // to say it is NOT patched.
  const code = ASSET_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

  assert.equal(/HTMLFormElement/.test(code), false, "no reference to HTMLFormElement at all");
  assert.equal(/(HTMLElement|EventTarget|Element|Node|HTMLButtonElement)\s*\.\s*prototype/.test(code), false, "no built-in DOM prototype reference");
  assert.equal(/\.\s*prototype\s*\.\s*(submit|requestSubmit|addEventListener|dispatchEvent)\s*=/.test(code), false, "no built-in prototype method reassignment");

  const { w } = await setup();
  const proto = w.HTMLFormElement.prototype as unknown as Record<string, unknown>;
  const formInstance = w.document.getElementById("pf-sec1") as HTMLFormElement;
  assert.equal(Object.prototype.hasOwnProperty.call(formInstance, "submit"), false, "no per-instance submit shadow");
  assert.equal(Object.prototype.hasOwnProperty.call(formInstance, "requestSubmit"), false, "no per-instance requestSubmit shadow");
  assert.equal(typeof proto.requestSubmit, "function", "requestSubmit still resolves to jsdom's implementation");
});

test("4A.5.1-19: an ambiguous owning form fails closed AND still contains the native controls it can see", async () => {
  // two rival product forms in the section with DIFFERENT hidden ids and no product-form
  // wrapper to disambiguate → ownership ambiguous.
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main>
      <div data-section-id="sec1" id="shopify-section-sec1">
        <form data-type="add-to-cart-form" action="/cart/add"><input type="hidden" name="id" value="1001"><button type="submit" name="add" data-native-a>A</button></form>
        <form data-type="add-to-cart-form" action="/cart/add"><input type="hidden" name="id" value="1002"><button type="submit" name="add" data-native-b>B</button></form>
        ${pricingRootHtml({
          "data-sku": "", "data-variant-id": "1001", "data-variant-sku": "", "data-variant-available": "true",
          "data-product-gid": PRODUCT_GID, "data-shopify-product-id": PRODUCT_ID, "data-section-id": "sec1",
          "data-variant-map": JSON.stringify(LNY01_MAP), "data-proxy-path": "/apps/imprintid-pricing/pricing", "data-show-breakdown": "false",
        })}
      </div>
    </main></body></html>`,
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

  assert.equal((block as { variantSyncUnavailable: boolean }).variantSyncUnavailable, true, "failed closed on ambiguous ownership");
  assert.equal(contained(w.document.querySelector("[data-native-a]")), true, "native control A contained");
  assert.equal(contained(w.document.querySelector("[data-native-b]")), true, "native control B contained");
  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0);
});
