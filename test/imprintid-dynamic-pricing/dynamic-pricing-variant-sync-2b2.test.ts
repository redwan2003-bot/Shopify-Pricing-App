/**
 * Task 2B.2 / 2B.3 — MULTI-VARIANT & MISSING-METADATA FAIL-CLOSED BEHAVIOR. Genuine
 * execution tests (real DOM via jsdom, real `PricingBlock` instances, mocked `fetch`)
 * proving the block fails closed — no catalog request, no pricing request, no
 * `/cart/add.js`, Add to Cart disabled, the localized `variant_sync_error` shown —
 * whenever it cannot safely resolve which real Shopify variant a customer is on:
 *
 *   - a multi-variant product whose owning Shopify section can't be resolved (so
 *     `shopify:product:select` never reaches it and a Red/Blue selection would silently
 *     keep pricing the initially rendered variant — the confirmed defect);
 *   - a `data-variant-map` that is malformed, empty, has an invalid id, is internally
 *     inconsistent, is missing the initial variant, or whose only variant is unavailable;
 *   - a `data-variant-map` that is ABSENT / blank / whitespace-only (Task 2B.3 — this is
 *     no longer a legacy single-variant / preview bypass).
 *
 * The one safe exception is also proven: an EXPLICIT `data-variant-map` with exactly
 * one validated, available entry matching the initial Liquid variant works with no
 * section.
 *
 * No color name (Black/Red/Blue) and no real Shopify id from this project's store is
 * hardcoded — every id/SKU/GID below is a synthetic, deliberately generic fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const PRODUCT_GID = "gid://shopify/Product/9000000000001";

// The real localized strings the block ships with — flattened exactly the way
// dynamic-pricing.liquid builds `window.ImprintIdPricingStrings` (one dotted key per
// entry). Proves the block renders the *existing* localized message, not a hardcoded
// English string invented for this task.
const LOCALE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../extensions/imprintid-dynamic-pricing/locales/en.default.json", import.meta.url)),
    "utf8",
  ),
) as { dynamic_pricing: Record<string, string> };
const STRINGS: Record<string, string> = Object.fromEntries(
  Object.entries(LOCALE.dynamic_pricing).map(([k, v]) => ["dynamic_pricing." + k, v]),
);
const VARIANT_SYNC_ERROR = STRINGS["dynamic_pricing.variant_sync_error"]!;

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

const MULTI_VARIANT_MAP = {
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
  rawVariantMap?: string; // overrides variantMap — used for genuinely malformed JSON / blank strings
  omitVariantMap?: boolean; // Task 2B.3 — render NO data-variant-map attribute at all
  variantId?: string;
  variantSku?: string;
  variantAvailable?: boolean;
  productGid?: string;
  sectionId?: string | null; // null omits data-section-id + the section wrapper entirely
}

async function setupPricingBlock(options: SetupOptions) {
  const sectionId = options.sectionId === undefined ? "sec1" : options.sectionId;

  const rootAttrs: Record<string, string> = {
    "data-sku": options.variantSku ?? "LNY01-A",
    "data-variant-id": options.variantId ?? "1001",
    "data-variant-sku": options.variantSku ?? "LNY01-A",
    "data-variant-available": String(options.variantAvailable ?? true),
    "data-product-gid": options.productGid ?? PRODUCT_GID,
    "data-proxy-path": "/apps/imprintid-pricing/pricing",
    "data-show-breakdown": "false",
  };
  if (!options.omitVariantMap) {
    rootAttrs["data-variant-map"] =
      options.rawVariantMap !== undefined ? options.rawVariantMap : JSON.stringify(options.variantMap ?? MULTI_VARIANT_MAP);
  }
  if (sectionId !== null) rootAttrs["data-section-id"] = sectionId;

  const sectionOpen = sectionId !== null ? `<div data-section-id="${sectionId}" id="shopify-section-${sectionId}">` : `<div>`;

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      ${sectionOpen}
        ${pricingRootHtml(rootAttrs)}
      </div>
    </body></html>`,
    { url: "https://example-shop.myshopify.com/products/lny01", runScripts: "outside-only" },
  );

  (globalThis as unknown as { window: typeof dom.window }).window = dom.window;
  globalThis.document = dom.window.document as unknown as Document;
  // The block's `t()` reads `window.ImprintIdPricingStrings` — set it on the jsdom
  // window (which IS the module's `window`), not just globalThis, so these tests can
  // assert on the real localized copy the block ships.
  (dom.window as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };
  (globalThis as unknown as { ImprintIdPricingStrings: Record<string, string> }).ImprintIdPricingStrings = { ...STRINGS };

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

  return { dom, root, block, fetchCalls, sectionId };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dispatchProductSelect(dom: JSDOM, target: EventTarget, opts: { productId: string; promise: Promise<unknown>; selectedOptions?: Record<string, string> }) {
  const EventCtor = dom.window as unknown as { CustomEvent: typeof CustomEvent };
  const event = new EventCtor.CustomEvent("shopify:product:select", { bubbles: true }) as CustomEvent & {
    product: { id: string };
    selectedOptions: Record<string, string>;
    promise: Promise<unknown>;
  };
  event.product = { id: opts.productId };
  event.selectedOptions = opts.selectedOptions ?? {};
  event.promise = opts.promise;
  target.dispatchEvent(event);
}

function btn(root: Element) {
  return root.querySelector("[data-imprintid-pricing-add-to-cart]") as HTMLButtonElement;
}
function unavailableEl(root: Element) {
  return root.querySelector("[data-imprintid-pricing-unavailable]") as HTMLElement;
}

// ============================================================================
// 1–7 — multi-variant product, missing section: the full fail-closed contract
// ============================================================================

test("1: a multi-variant product with no resolvable owning section fails closed", async () => {
  const { block } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
  });
  await wait(50);

  assert.equal((block as { variantSynchronizationRequired: boolean }).variantSynchronizationRequired, true, "3-entry map ⇒ sync required");
  assert.equal((block as { variantSynchronizationReady: boolean }).variantSynchronizationReady, false, "no section ⇒ not ready");
  assert.equal((block as { variantSyncUnavailable: boolean }).variantSyncUnavailable, true, "must have entered the fail-closed state");
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
});

test("2: it performs no catalog request", async () => {
  const { fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
  });
  await wait(50);
  assert.equal(fetchCalls.filter((c) => c.method === "GET").length, 0);
});

test("3: it performs no pricing request", async () => {
  const { fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
  });
  await wait(50);
  assert.equal(fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing")).length, 0);
});

test("4: a direct programmatic addToCart() performs no cart request and cannot bypass the guard", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
  });
  await wait(50);

  // Call the method directly — not via the (never-bound) click listener.
  (block as { addToCart: () => void }).addToCart();
  await wait(50);

  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0);
  assert.equal(btn(root).disabled, true);
});

test("5: any existing quote state is cleared when the fail-closed guard trips", async () => {
  const { block } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
  });
  await wait(50);

  // Simulate a stale quote having been left on the instance, then hit a guarded entry
  // point (a direct recalculation) — it must be scrubbed, not acted on.
  (block as { cartPricing: unknown }).cartPricing = { version: 1, payload: "{}", signature: "sig" };
  (block as { quotedVariantId: unknown }).quotedVariantId = "1001";
  (block as { quotedVariantSku: unknown }).quotedVariantSku = "LNY01-A";
  (block as { recalculate: () => void }).recalculate();
  await wait(400);

  assert.equal((block as { cartPricing: unknown }).cartPricing, null);
  assert.equal((block as { quotedVariantId: unknown }).quotedVariantId, null);
  assert.equal((block as { quotedVariantSku: unknown }).quotedVariantSku, null);
});

test("6: Add to Cart remains disabled", async () => {
  const { root } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
  });
  await wait(50);
  assert.equal(btn(root).disabled, true);
});

test("7: the localized variant_sync_error is displayed (no hardcoded English)", async () => {
  const { root } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
  });
  await wait(50);
  const el = unavailableEl(root);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, VARIANT_SYNC_ERROR);
});

// ============================================================================
// 8–9 — the safe single-variant exception
// ============================================================================

test("8: exactly one validated, available variant matching the initial variant works with no section", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
    variantMap: { "1001": { sku: "LNY01-A", available: true } },
    variantId: "1001",
    variantSku: "LNY01-A",
  });
  await wait(50);

  assert.equal((block as { variantSynchronizationRequired: boolean }).variantSynchronizationRequired, false);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), true);
  assert.ok(fetchCalls.some((c) => c.method === "GET"), "the catalog is loaded normally");
  assert.ok(fetchCalls.some((c) => c.method === "POST" && c.url.includes("pricing")), "a pricing request is made normally");
  assert.equal(btn(root).disabled, false, "Add to Cart enables once the single-variant quote lands");
});

test("9: exactly one variant, marked unavailable, fails closed", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    sectionId: null,
    variantMap: { "1001": { sku: "LNY01-A", available: false } },
    variantId: "1001",
  });
  await wait(50);

  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
  assert.equal(unavailableEl(root).textContent, VARIANT_SYNC_ERROR);
});

// ============================================================================
// 10–13 — invalid / inconsistent metadata (with a section present, to prove it
// is the METADATA that trips the guard, not the section)
// ============================================================================

test("10: a malformed (truncated) variant map fails closed even with a valid section", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    rawVariantMap: '{"1001":{"sku":"LNY01-A","available":true',
  });
  await wait(50);

  assert.equal((block as { variantMetadataValid: boolean }).variantMetadataValid, false);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
  assert.equal(unavailableEl(root).textContent, VARIANT_SYNC_ERROR);
});

test("11: an empty variant map fails closed even with a valid section", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    rawVariantMap: "{}",
  });
  await wait(50);

  assert.equal((block as { validatedVariantCount: number }).validatedVariantCount, 0);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
});

test("12: the initial variant being absent from the map fails closed", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    variantMap: { "1002": { sku: "LNY01-B", available: true }, "1003": { sku: "LNY01-C", available: true } },
    variantId: "1001", // not in the map
  });
  await wait(50);

  assert.equal((block as { initialVariantEntry: unknown }).initialVariantEntry, null);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
});

test("13: an invalid variant id (non-numeric key) anywhere in the map fails closed", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    rawVariantMap: JSON.stringify({ "1001": { sku: "LNY01-A", available: true }, "not-an-id": { sku: "LNY01-B", available: true } }),
  });
  await wait(50);

  assert.equal((block as { variantMetadataValid: boolean }).variantMetadataValid, false);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
});

// ============================================================================
// 14–15 — the happy path is untouched
// ============================================================================

test("14: a valid multi-variant product WITH a resolvable Horizon section remains fully functional", async () => {
  const gets: string[] = [];
  const { dom, root, block, fetchCalls, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => {
      if (call.method === "GET") {
        gets.push(call.url);
        return call.url.includes("LNY01-B") ? catalogFor("LNY01-B") : catalogFor("LNY01-A");
      }
      return buildCalcResponse();
    },
  });
  await wait(50);

  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), true);
  assert.equal(gets.length, 1, "initial catalog loaded");
  assert.equal(btn(root).disabled, false, "initial quote lands, Add to Cart enabled");

  // A real variant selection still synchronises normally.
  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(50);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002");
  assert.equal((block as { selectedVariantSku: string }).selectedVariantSku, "LNY01-B");
  assert.equal(gets.length, 2, "the SKU change refetched the catalog");
  const posts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("pricing"));
  assert.equal((posts[posts.length - 1]!.body as { sku: string }).sku, "LNY01-B");
});

test("15: id-based event synchronization still works with no hardcoded color mapping", async () => {
  const { dom, block, sectionId } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    // Both entries share a SKU so this routes through the debounced recalculation path,
    // isolating "did the block adopt the new id" from any catalog-refetch behavior.
    variantMap: { "1001": { sku: "LNY01-A", available: true }, "1002": { sku: "LNY01-A", available: true } },
  });
  await wait(50);

  const sectionEl = dom.window.document.getElementById("shopify-section-" + sectionId)!;
  // `selectedOptions` carries an arbitrary option label — the block never reads it; it
  // only ever resolves the numeric id from the event's own promise.
  dispatchProductSelect(dom, sectionEl, {
    productId: PRODUCT_GID,
    selectedOptions: { "Some Option": "some-value" },
    promise: Promise.resolve({ variant: { id: "gid://shopify/ProductVariant/1002", availableForSale: true } }),
  });
  await wait(400);

  assert.equal((block as { selectedVariantId: string }).selectedVariantId, "1002", "adopted purely by numeric id — no color name involved");
});

// ============================================================================
// 16–20 — Task 2B.3: a MISSING / blank variant-map fails closed (no legacy bypass)
// ============================================================================

test("16: no data-variant-map attribute at all -> fails closed (invalid metadata, not a preview bypass)", async () => {
  const { block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    omitVariantMap: true,
  });
  await wait(50);

  assert.equal((block as { variantMetadataValid: boolean }).variantMetadataValid, false, "missing metadata must be invalid");
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal((block as { variantSyncUnavailable: boolean }).variantSyncUnavailable, true);
  assert.equal(fetchCalls.length, 0, "no catalog request and no pricing request");
});

test("17: data-variant-id present but data-variant-map absent still fails closed (never inferred as single-variant)", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    omitVariantMap: true,
    variantId: "1001",
    variantSku: "LNY01-A",
  });
  await wait(50);

  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false, "an initial variant id alone is not explicit single-variant evidence");
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
  assert.equal(unavailableEl(root).textContent, VARIANT_SYNC_ERROR);
});

test("18: an empty-string data-variant-map fails closed", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    rawVariantMap: "",
  });
  await wait(50);

  assert.equal((block as { variantMetadataValid: boolean }).variantMetadataValid, false);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
});

test("19: a whitespace-only data-variant-map fails closed", async () => {
  const { root, block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    rawVariantMap: "      ",
  });
  await wait(50);

  assert.equal((block as { variantMetadataValid: boolean }).variantMetadataValid, false);
  assert.equal((block as { canUseDynamicPricing: () => boolean }).canUseDynamicPricing(), false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(btn(root).disabled, true);
});

test("20: a direct programmatic addToCart() cannot bypass the missing-metadata failure", async () => {
  const { block, fetchCalls } = await setupPricingBlock({
    fetchHandler: (call) => (call.method === "GET" ? catalogFor("LNY01-A") : buildCalcResponse()),
    omitVariantMap: true,
  });
  await wait(50);

  (block as { addToCart: () => void }).addToCart();
  await wait(50);

  assert.equal(fetchCalls.filter((c) => c.url.includes("/cart/add.js")).length, 0);
  assert.equal(fetchCalls.length, 0, "still no catalog/pricing request either");
});
