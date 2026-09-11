/**
 * Task 5B.3B Phase 1 — final local corrections:
 *
 *   1. EXACT accessibility-state preservation. Before containing a native control the
 *      block records its original `disabled`, whether `aria-disabled` existed, and its
 *      exact value; an authoritative `bypass` restores all three byte-for-byte and never
 *      re-enables a control Shopify/the theme originally disabled.
 *
 *   2. POLICY BOOTSTRAP. A block that fails closed on malformed variant metadata (and so
 *      never reaches the catalog/pricing path) learns the authoritative enforcement
 *      decision through a minimal `?policyOnly=1&shopifyProductId=<id>` lookup — no
 *      variant id / SKU / variant map / pricing calculation. Starts contained; released
 *      only by an explicit current-product `bypass`; deduplicated; ownership-checked.
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
type State = "enforce" | "bypass" | "block";

const GOOD_MAP = JSON.stringify({ "1001": { sku: "", available: true }, "1002": { sku: "", available: true } });

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
  variantMap?: string; // raw; default a good map. Pass "" or a malformed string to fail closed.
  omitVariantMap?: boolean;
  /** native main button's attributes as authored by the theme. */
  mainAttrs?: string;
  /** state the mock returns for the `policyOnly` GET. `null` = malformed body; "err" = network error. */
  policyState?: State | null | "err";
  /** state for the normal catalog GET + calc POST (when metadata is valid). */
  catalogState?: State;
  shopifyProductId?: string | null;
}

async function setup(options: SetupOptions = {}) {
  const rootAttrs: Record<string, string> = {
    "data-sku": "", "data-variant-id": "1001", "data-variant-sku": "", "data-variant-available": "true",
    "data-product-gid": PRODUCT_GID, "data-section-id": "sec1",
    "data-proxy-path": "/apps/imprintid-pricing/pricing", "data-show-breakdown": "false",
  };
  if (options.shopifyProductId !== null) rootAttrs["data-shopify-product-id"] = options.shopifyProductId ?? PRODUCT_ID;
  if (!options.omitVariantMap) rootAttrs["data-variant-map"] = options.variantMap ?? GOOD_MAP;

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main>
      <div data-section-id="sec1" id="shopify-section-sec1">
        <product-form>
          <form id="pf-sec1" data-type="add-to-cart-form" action="/cart/add">
            <input type="hidden" name="id" value="1001">
            <button type="submit" name="add" data-native-main ${options.mainAttrs ?? ""}>Add to cart</button>
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
  const cfg = { policy: options.policyState === undefined ? ("block" as State) : options.policyState, catalog: options.catalogState ?? "block" };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method as string) || "GET";
    fetchCalls.push({ url, method });
    if (url.includes("policyOnly")) {
      if (cfg.policy === "err") throw new Error("network");
      if (cfg.policy === null) return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) } as Response;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { enforcement: { state: cfg.policy } } }) } as Response;
    }
    if (url.includes("/cart/add.js")) return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
    const payload = {
      ok: true,
      data: {
        sku: "", identity: { shopifyProductId: PRODUCT_ID, shopifyVariantId: "1001", resolutionSource: "product_override" },
        enforcement: { state: cfg.catalog },
        quantityTiers: [{ minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 }],
        productColors: [], decorationMethods: [], optionGroups: [],
        productionRules: [{ code: "STD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null }],
        quantity: 100,
        quantityTier: { id: "t1", minQuantity: 100, maxQuantity: 299, priceCode: null, listUnitPriceCents: 229, netUnitPriceCents: 137 },
        availableQuantityTiers: [],
        base: { quantity: 100, listUnitPriceCents: 229, netUnitPriceCents: 137, listSubtotalCents: 22900, netSubtotalCents: 13700 },
        productColor: null, decoration: null, options: { selections: [], chargesCents: 0 },
        production: { code: "STD", name: "Standard", isRush: false, minBusinessDays: 7, maxBusinessDays: 8, relatedSku: null, feeCents: null, notes: null },
        packaging: null, totals: { listTotalCents: 22900, netTotalCents: 13700 }, cartPricing: null,
      },
    };
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
  return { dom, w, root, block, fetchCalls, cfg };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (dom: JSDOM, sel: string) => dom.window.document.querySelector(sel) as HTMLElement;
const contained = (el: Element | null) => !!el && el.getAttribute("data-imprintid-contained") === "1";
const policyCalls = (c: FetchCall[]) => c.filter((x) => x.url.includes("policyOnly"));
const pricingCalls = (c: FetchCall[]) => c.filter((x) => !x.url.includes("policyOnly") && !x.url.includes("/cart/add.js"));

// ============================================================================
// Phase 1.1 — exact accessibility-state preservation
// ============================================================================

test("5B.3B-1: original had NO aria-disabled → contained adds aria-disabled='true'; bypass REMOVES it entirely", async () => {
  const { dom } = await setup({ catalogState: "bypass" }); // valid metadata; catalog says bypass
  await wait(100);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  assert.equal(main.hasAttribute("aria-disabled"), false, "aria-disabled removed — the theme never authored it");
  assert.equal(main.disabled, false);
});

test("5B.3B-2: original aria-disabled='false' → restored to EXACTLY 'false' on bypass (not removed)", async () => {
  const { dom } = await setup({ mainAttrs: 'aria-disabled="false"', catalogState: "bypass" });
  await wait(100);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  assert.equal(main.getAttribute("aria-disabled"), "false", "exact original value restored");
});

test("5B.3B-3: original aria-disabled='true' → restored to EXACTLY 'true' on bypass", async () => {
  const { dom } = await setup({ mainAttrs: 'aria-disabled="true"', catalogState: "bypass" });
  await wait(100);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  assert.equal(main.getAttribute("aria-disabled"), "true");
});

test("5B.3B-4: a control Shopify originally DISABLED stays disabled after a bypass release", async () => {
  const { dom } = await setup({ mainAttrs: 'disabled aria-disabled="true"', catalogState: "bypass" });
  await wait(100);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  assert.equal(contained(main), false, "marker removed");
  assert.equal(main.disabled, true, "still disabled — that was Shopify's own state");
  assert.equal(main.getAttribute("aria-disabled"), "true", "and its own aria-disabled");
});

test("5B.3B-5: contain → release → re-contain leaves no leaked bookkeeping attributes", async () => {
  const { dom, block, cfg } = await setup({ mainAttrs: 'aria-disabled="false"', catalogState: "bypass" });
  await wait(100);
  const main = q(dom, "[data-native-main]") as HTMLButtonElement;
  assert.equal(main.getAttribute("aria-disabled"), "false");
  assert.equal(main.hasAttribute("data-imprintid-was-disabled"), false);
  assert.equal(main.hasAttribute("data-imprintid-had-aria-disabled"), false);
  assert.equal(main.hasAttribute("data-imprintid-orig-aria-disabled"), false);

  // shop toggles back to pilot → re-contain
  cfg.catalog = "block";
  (block as { recalculate: () => void }).recalculate();
  await wait(400);
  assert.equal(contained(main), true);
  assert.equal(main.getAttribute("aria-disabled"), "true");
  // and the recorded ORIGINAL is still 'false' for the next release
  assert.equal(main.getAttribute("data-imprintid-orig-aria-disabled"), "false");
});

// ============================================================================
// Phase 1.2 — policy bootstrap for malformed metadata
// ============================================================================

test("5B.3B-6: malformed variant metadata + policy `bypass` → native containment RELEASED (no pricing request)", async () => {
  const { dom, block, fetchCalls } = await setup({ variantMap: '{"1001":{"sku":null,"available":true}}', policyState: "bypass" });
  await wait(120);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false, "pricing failed closed");
  assert.equal((block as { _enforcementState: string })._enforcementState, "bypass");
  assert.equal(contained(q(dom, "[data-native-main]")), false, "native cart released");
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, false);
  assert.equal(policyCalls(fetchCalls).length, 1, "exactly one policy lookup");
  assert.equal(pricingCalls(fetchCalls).length, 0, "no catalog / pricing request");
});

test("5B.3B-7: malformed metadata + policy `pilot-unmarked` bypass → released", async () => {
  // (the provider reason is server-side; the browser only ever sees the state)
  const { dom, block } = await setup({ variantMap: "{ not json", policyState: "bypass" });
  await wait(120);
  assert.equal((block as { _enforcementState: string })._enforcementState, "bypass");
  assert.equal(contained(q(dom, "[data-native-main]")), false);
});

test("5B.3B-8: malformed metadata + policy `enforce` → stays contained", async () => {
  const { dom, block } = await setup({ omitVariantMap: true, policyState: "enforce" });
  await wait(120);
  assert.equal((block as { _enforcementState: string })._enforcementState, "enforce");
  assert.equal(contained(q(dom, "[data-native-main]")), true);
  assert.equal((q(dom, "[data-native-main]") as HTMLButtonElement).disabled, true);
});

test("5B.3B-9: malformed metadata + policy `block` (maintenance / provider failure) → stays contained", async () => {
  const { dom, block } = await setup({ omitVariantMap: true, policyState: "block" });
  await wait(120);
  assert.equal((block as { _enforcementState: string })._enforcementState, "block");
  assert.equal(contained(q(dom, "[data-native-main]")), true);
});

test("5B.3B-10: malformed metadata + a MALFORMED policy response → stays contained (fail closed)", async () => {
  const { dom, block } = await setup({ omitVariantMap: true, policyState: null });
  await wait(120);
  assert.equal((block as { _enforcementState: string })._enforcementState, "block");
  assert.equal(contained(q(dom, "[data-native-main]")), true);
});

test("5B.3B-11: malformed metadata + a NETWORK ERROR on the policy lookup → stays contained", async () => {
  const { dom, block } = await setup({ omitVariantMap: true, policyState: "err" });
  await wait(120);
  assert.equal((block as { _enforcementState: string })._enforcementState, "block");
  assert.equal(contained(q(dom, "[data-native-main]")), true);
});

test("5B.3B-12: a STALE policy `bypass` response cannot release a block that was torn down", async () => {
  let release: () => void = () => {};
  const { dom, block } = await setup({ omitVariantMap: true, policyState: "block" });
  await wait(80); // the initial probe resolved `block` → contained
  assert.equal(contained(q(dom, "[data-native-main]")), true);

  // a second probe now hangs and WOULD return `bypass`
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (i: unknown) => {
    if (String(i).includes("policyOnly")) {
      await new Promise<void>((r) => { release = r; });
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { enforcement: { state: "bypass" } } }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
  }) as typeof fetch;

  (block as { probeEnforcementState: () => void }).probeEnforcementState();
  await wait(30);
  (block as { destroy: () => void }).destroy();
  release();
  await wait(80);

  assert.equal((block as { _enforcementState: string })._enforcementState, "block", "the stale bypass never applied");
  assert.equal(contained(q(dom, "[data-native-main]")), true);
});

test("5B.3B-13: the policy lookup is deduplicated to one active request per block", async () => {
  const { block, fetchCalls } = await setup({ omitVariantMap: true, policyState: "block" });
  // fire several more times synchronously before the first resolves
  (block as { probeEnforcementState: () => void }).probeEnforcementState();
  (block as { probeEnforcementState: () => void }).probeEnforcementState();
  (block as { probeEnforcementState: () => void }).probeEnforcementState();
  await wait(120);
  assert.equal(policyCalls(fetchCalls).length, 1, "one active request only");
});

test("5B.3B-14: the policy lookup carries only the product id — no variant id / sku / pricing params", async () => {
  const { fetchCalls } = await setup({ omitVariantMap: true, policyState: "block" });
  await wait(80);
  const url = policyCalls(fetchCalls)[0]!.url;
  assert.ok(url.includes("policyOnly=1"));
  assert.ok(url.includes("shopifyProductId=" + PRODUCT_ID));
  assert.equal(/shopifyVariantId|[?&]sku=/.test(url), false, "no variant id / sku");
});

test("5B.3B-15: a block with NO product id never makes a policy lookup", async () => {
  const { fetchCalls, block } = await setup({ omitVariantMap: true, shopifyProductId: null, policyState: "bypass" });
  await wait(80);
  assert.equal(policyCalls(fetchCalls).length, 0);
  assert.equal((block as { _enforcementState: string })._enforcementState, "block");
});
