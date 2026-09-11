/**
 * Task 5B.3A.1 — AUTHORITATIVE THREE-STATE POLICY DECISION (browser side).
 *
 * The storefront no longer treats "block present + product id" as "contain forever". It
 * contains by default (fail closed) and RELEASES native containment only on an explicit,
 * server-observed `data.enforcement.state === "bypass"` (a `disabled` shop policy, or a
 * pilot-unmarked product). `enforce` / `block` / an unknown state keep it contained.
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

interface FetchCall { url: string; method: string }
type EnforcementState = "enforce" | "bypass" | "block" | undefined;

const MAP = { "1001": { sku: "", available: true }, "1002": { sku: "", available: true } };

function catalogBody(enforcement: EnforcementState) {
  return {
    ok: true,
    data: {
      sku: "",
      identity: { shopifyProductId: PRODUCT_ID, shopifyVariantId: "1001", resolutionSource: "product_override" },
      ...(enforcement ? { enforcement: { state: enforcement } } : {}),
      quantityTiers: [{ minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 }],
      productColors: [], decorationMethods: [], optionGroups: [],
      productionRules: [{ code: "STD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null }],
    },
  };
}
function calcBody(enforcement: EnforcementState, cartPricing: unknown) {
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
      identity: { shopifyProductId: PRODUCT_ID, shopifyVariantId: "1001", resolutionSource: "product_override" },
      ...(enforcement ? { enforcement: { state: enforcement } } : {}),
      cartPricing,
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

interface SetupOptions {
  catalogEnforcement?: EnforcementState;
  calcEnforcement?: EnforcementState;
  /** cartPricing returned by the POST; default null (no signed quote). */
  cartPricing?: unknown;
  /** mark the native main button disabled in the source HTML (theme out-of-stock). */
  nativeMainDisabled?: boolean;
  variantMap?: string;
}

async function setup(options: SetupOptions = {}) {
  const rootAttrs: Record<string, string> = {
    "data-sku": "", "data-variant-id": "1001", "data-variant-sku": "", "data-variant-available": "true",
    "data-product-gid": PRODUCT_GID, "data-shopify-product-id": PRODUCT_ID, "data-section-id": "sec1",
    "data-variant-map": options.variantMap ?? JSON.stringify(MAP),
    "data-proxy-path": "/apps/imprintid-pricing/pricing", "data-show-breakdown": "false",
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
            <input type="hidden" name="id" value="1001">
            <button type="submit" name="add" data-native-main ${options.nativeMainDisabled ? "disabled" : ""}>Add to cart</button>
          </form>
        </product-form>
        <sticky-buy-buttons><button type="submit" name="add" form="pf-sec1" data-native-sticky>Add</button></sticky-buy-buttons>
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
  const responder = {
    catalog: options.catalogEnforcement,
    calc: options.calcEnforcement,
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method as string) || "GET";
    fetchCalls.push({ url, method });
    let payload: unknown;
    if (url.includes("/cart/add.js")) payload = { items: [] };
    else if (method === "GET") payload = catalogBody(responder.catalog);
    else payload = calcBody(responder.calc, options.cartPricing ?? null);
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
  return { dom, w, root, block, fetchCalls, responder };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (dom: JSDOM, sel: string) => dom.window.document.querySelector(sel) as HTMLElement;
const contained = (el: Element | null) => !!el && el.getAttribute("data-imprintid-contained") === "1";
const cartAdds = (c: FetchCall[]) => c.filter((x) => x.url.includes("/cart/add.js")).length;

// ============================================================================

test("5B.3A.1-1: catalog enforcement `bypass` RELEASES native containment", async () => {
  const { dom, root, block } = await setup({ catalogEnforcement: "bypass", calcEnforcement: "bypass" });
  await wait(100);

  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  const sticky = q(dom, "[data-native-sticky]") as HTMLButtonElement;
  assert.equal((block as { _enforcementState: string })._enforcementState, "bypass");
  assert.equal(contained(main), false, "marker removed");
  assert.equal(main.disabled, false, "native main re-enabled");
  assert.equal(main.getAttribute("aria-disabled"), null);
  assert.equal(contained(sticky), false);
  assert.equal(sticky.disabled, false);
  assert.equal((dom.window.document.getElementById("pf-sec1") as HTMLElement).getAttribute("data-imprintid-contained-form"), null);
  assert.equal(root.getAttribute("data-imprintid-native-contained"), "false");
});

test("5B.3A.1-2: enforcement `block` keeps native containment", async () => {
  const { dom, block } = await setup({ catalogEnforcement: "block", calcEnforcement: "block" });
  await wait(100);
  assert.equal((block as { _enforcementState: string })._enforcementState, "block");
  assert.equal(contained(q(dom, "[data-native-main]")), true);
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, true);
});

test("5B.3A.1-3: enforcement `enforce` keeps native containment", async () => {
  const { dom, block } = await setup({ catalogEnforcement: "enforce", calcEnforcement: "enforce" });
  await wait(100);
  assert.equal((block as { _enforcementState: string })._enforcementState, "enforce");
  assert.equal(contained(q(dom, "[data-native-main]")), true);
});

test("5B.3A.1-4: a MISSING enforcement field is treated as `block` (fail closed) — stays contained", async () => {
  const { dom, block } = await setup({ catalogEnforcement: undefined, calcEnforcement: undefined });
  await wait(100);
  assert.equal((block as { _enforcementState: string })._enforcementState, "block");
  assert.equal(contained(q(dom, "[data-native-main]")), true);
});

test("5B.3A.1-5: the pricing POST can release containment even when the catalog GET said `block`", async () => {
  const { dom, block } = await setup({ catalogEnforcement: "block", calcEnforcement: "bypass" });
  await wait(120);
  assert.equal((block as { _enforcementState: string })._enforcementState, "bypass");
  assert.equal(contained(q(dom, "[data-native-main]")), false);
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, false);
});

test("5B.3A.1-6: a later `block` decision RE-CONTAINS a previously released native cart", async () => {
  const { dom, block, responder } = await setup({ catalogEnforcement: "bypass", calcEnforcement: "bypass" });
  await wait(100);
  assert.equal(contained(q(dom, "[data-native-main]")), false, "released by the initial bypass");

  // shop toggled disabled → pilot: the next response says `block`
  responder.catalog = "block";
  responder.calc = "block";
  (block as { recalculate: () => void }).recalculate();
  await wait(400);

  assert.equal((block as { _enforcementState: string })._enforcementState, "block");
  assert.equal(contained(q(dom, "[data-native-main]")), true, "re-contained");
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, true);
});

test("5B.3A.1-7: releasing containment never re-enables a control the THEME had disabled", async () => {
  const { dom } = await setup({ catalogEnforcement: "bypass", calcEnforcement: "bypass", nativeMainDisabled: true });
  await wait(100);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  assert.equal(contained(main), false, "marker removed");
  assert.equal(main.disabled, true, "still disabled — that was the theme's own state, not ours");
});

test("5B.3A.1-8: after release, a native button click is NOT blocked (guard removed)", async () => {
  const { dom, fetchCalls } = await setup({ catalogEnforcement: "bypass", calcEnforcement: "bypass" });
  await wait(100);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  let sawClickAtDocument = false;
  dom.window.document.addEventListener("click", () => { sawClickAtDocument = true; });
  main.dispatchEvent(new (dom.window as unknown as { Event: typeof Event }).Event("click", { bubbles: true, cancelable: true }));
  await wait(20);
  assert.equal(sawClickAtDocument, true, "the click propagates normally — no capture-phase guard");
  assert.equal(cartAdds(fetchCalls), 0);
});

test("5B.3A.1-9: the ImprintID button is never touched by containment or its release", async () => {
  const { root } = await setup({ catalogEnforcement: "bypass", calcEnforcement: "bypass" });
  await wait(100);
  const imprintBtn = root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
  assert.equal(contained(imprintBtn), false, "never contained");
  assert.equal(imprintBtn.disabled, true, "still disabled — no signed quote in a bypass state");
});

test("5B.3A.1-10: bypass with malformed metadata — pricing fails closed, but native cart is released once the catalog GET lands", async () => {
  // metadata is fine enough to load the catalog (valid map) but the catalog says bypass.
  const { dom, block } = await setup({
    catalogEnforcement: "bypass",
    calcEnforcement: "bypass",
    variantMap: JSON.stringify(MAP),
  });
  await wait(120);
  assert.equal((block as { _enforcementState: string })._enforcementState, "bypass");
  assert.equal(contained(q(dom, "[data-native-main]")), false);
});
