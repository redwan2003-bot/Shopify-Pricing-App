/**
 * Dynamic Pricing block behavior.
 *
 * This file never computes a price. Every number it displays comes verbatim from a
 * GET/POST to /apps/imprintid-pricing/pricing (the Phase 2.5 App Proxy route, which
 * itself only ever calls the Phase 2.3 calculation engine — see
 * docs/storefront-pricing-ui.md and docs/storefront-pricing-bridge.md). The only
 * arithmetic performed here is `cents / 100` for display formatting, which the
 * project's Phase 2.6 spec explicitly allows ("It may only convert cents to display
 * currency").
 *
 * No build step: this runs as a native ES module script tag in the storefront (loaded
 * with `type="module"` — see the block's Liquid), written in vanilla ES2020+ with only
 * browser APIs (fetch, AbortController, Intl) — no new dependency was introduced for
 * it. `import`/`export` here work the same way any relative-path ES module import
 * does: resolved relative to this file's own URL, which Shopify serves from the same
 * asset folder as dynamic-pricing-utils.js.
 *
 * TASK 2B — variant synchronization (see docs of the individual methods below for the
 * detailed contract). Summary: the block's own form fields (quantity/options/etc.)
 * were always tracked correctly, but which real Shopify *variant* a quote/Add to Cart
 * applies to was previously captured once, at page render, and never revisited — a
 * customer changing color/size after that point would get a correctly-priced quote for
 * the WRONG variant, and Add to Cart would add that wrong variant with a validly-signed
 * price payload attached to it. This file now tracks the selected variant explicitly,
 * listens for Shopify's official `shopify:product:select` standard storefront event to
 * learn about changes promptly, cross-checks that against the page's own hidden
 * variant-id form field as a fallback/sanity check, and blocks Add to Cart outright on
 * any mismatch between what's selected and what was actually quoted — see
 * `handleProductSelect`, `crossCheckFormInput`, and `addToCart` below.
 */
import {
  formatMoney as formatMoneyRaw,
  slugify,
  classifyResolvedPriceCents,
  parseProductVariantGid,
  parseProductGid,
  isPositiveDigitString,
  parseVariantMap,
  resolveVariantFromMap,
  readVariantMap,
  parseShopifyNumericId,
  checkResponseIdentity,
  readSignedV2Quote,
  isSignedV2QuoteExpired,
  signedV2QuoteAttributes,
  legacyV1QuoteAttributes,
} from "./dynamic-pricing-utils.js";

(function () {
  "use strict";

  var DEBOUNCE_MS = 300;

  var MESSAGES = {
    unsupported: "dynamic_pricing.unsupported_product",
    invalidQuantity: "dynamic_pricing.invalid_quantity",
    configurationError: "dynamic_pricing.configuration_error",
    networkError: "dynamic_pricing.network_error",
    addToCart: "dynamic_pricing.add_to_cart",
    addingToCart: "dynamic_pricing.adding_to_cart",
    addedToCart: "dynamic_pricing.added_to_cart",
    addToCartError: "dynamic_pricing.add_to_cart_error",
    addToCartUnavailable: "dynamic_pricing.add_to_cart_unavailable",
    variantChanged: "dynamic_pricing.variant_changed",
    variantUnavailable: "dynamic_pricing.variant_unavailable",
    variantSyncError: "dynamic_pricing.variant_sync_error",
  };

  // Error codes the pricing engine can return that specifically mean "the quantity
  // you entered isn't valid" — see app/lib/pricing/errors.ts. Everything else that
  // isn't a not-found/unsupported-product code is treated as a general configuration
  // error (STEP 15's message #3).
  var QUANTITY_ERROR_CODES = ["INVALID_QUANTITY", "QUANTITY_BELOW_MINIMUM"];
  var UNSUPPORTED_ERROR_CODES = [
    "STORE_NOT_FOUND",
    "PRICING_PROFILE_NOT_FOUND",
    "PRICING_PROFILE_INACTIVE",
    "SHOP_NOT_AVAILABLE",
  ];

  // The real, first-party, documented Shopify "standard storefront event" for a
  // variant-selection change (see shopify.dev/docs/storefronts/themes/best-practices/
  // standard-events, and confirmed live in Horizon's own product-form.js, which
  // registers its own internal handler against this exact event name). Deliberately
  // NOT `variant:change` (that event belongs to Maestrooo themes, not Horizon/Shopify's
  // standard-events system) and NOT anything invented for this task.
  var PRODUCT_SELECT_EVENT = "shopify:product:select";

  var formatMoney = function (cents) {
    return formatMoneyRaw(cents, document.documentElement.lang);
  };

  function t(root, key, fallback) {
    var dict = window.ImprintIdPricingStrings || {};
    return dict[key] || fallback || key;
  }

  function qs(root, selector) {
    return root.querySelector(selector);
  }

  // Task 4A.5 — contexts within the owning section whose `input[name="id"]` / variant
  // controls belong to a DIFFERENT purchasable unit (a quick-add tile, a product card
  // in a recommendation row, a bundled/complementary product) and must never be
  // mistaken for this block's own product form or variant picker.
  var EXCLUDED_FORM_CONTEXT_SELECTOR =
    "quick-add-modal,quick-add,quick-order-list,[data-quick-add]," +
    "product-card,.product-card,.card-product,.card--product,[data-product-card]," +
    "product-recommendations,.product-recommendations,recommended-products," +
    ".complementary-products,.complementary-products__container";

  function isExcludedFormContext(el) {
    try {
      return !!(el && typeof el.closest === "function" && el.closest(EXCLUDED_FORM_CONTEXT_SELECTOR));
    } catch (e) {
      return false;
    }
  }

  // Preference order when a section legitimately contains more than one candidate
  // `input[name="id"]` for the SAME product (e.g. a main product form plus a sticky
  // buy-buttons form): the canonical `<product-form>` wins, then an explicit
  // add-to-cart form, then any other form.
  function formInputRank(input) {
    try {
      if (input.closest("product-form")) return 0;
      if (input.closest('form[data-type="add-to-cart-form"]')) return 1;
    } catch (e) {
      /* invalid selector engine — fall through */
    }
    return 2;
  }

  // Task 4A.5.1 — native purchase controls in the owning section that this block must
  // contain (disable + block) so a customer can never add the product with an UNSIGNED
  // line while the ImprintID block governs its pricing. Client containment is a UX
  // guard only — the Cart & Checkout Validation Function is the real boundary against
  // adversarial direct `/cart/add.js` calls.
  var NATIVE_SUBMIT_SELECTOR =
    'button[type="submit"],input[type="submit"],button[name="add"],input[name="add"],button:not([type])';
  // Wrappers a theme uses for a sticky / floating "add to cart" bar. Anything matched
  // here is still required to sit inside THIS block's section (the queries are
  // section-scoped) and to not be an excluded context, so a sticky bar for another
  // product — which lives in another section — is never touched.
  var STICKY_WRAPPER_SELECTOR =
    "sticky-buy-buttons,sticky-atc,sticky-cart,[data-sticky-buy-buttons],[data-sticky-atc]," +
    ".sticky-buy-buttons,.sticky-atc,.sticky-add-to-cart,.product-sticky,.product-form--sticky";

  // Minimal CSS identifier escaper for attribute-value selectors (Shopify form ids are
  // already `[A-Za-z0-9_-]`-only, but never trust that blindly). Prefers the platform
  // `CSS.escape` when present.
  function cssEscapeIdent(value) {
    var s = String(value == null ? "" : value);
    try {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
    } catch (e) {
      /* fall through to the manual escaper */
    }
    return s.replace(/[^\w-]/g, function (ch) {
      return "\\" + ch;
    });
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        fn.apply(self, args);
      }, ms);
    };
  }

  function PricingBlock(root) {
    this.root = root;
    this.sku = root.dataset.sku || "";
    this.proxyPath = root.dataset.proxyPath || "/apps/imprintid-pricing/pricing";
    this.catalog = null;
    // Task 4A.5 — the SKU `this.catalog` was successfully loaded for. A pricing POST is
    // only ever sent while this equals the active `selectedVariantSku`; a variant
    // adoption whose catalog refetch failed leaves the two out of sync, and
    // `_recalculateImmediate` then fails closed instead of pricing against the wrong
    // catalog.
    this.catalogSku = null;
    this.requestSeq = 0;
    this.activeController = null;
    // The signed cart pricing payload for the *currently displayed* result only — see
    // renderResult/clearCartPricing. Never reused across a configuration change: every
    // recalculation clears this first, so Add to Cart can only ever submit a payload
    // that was genuinely signed for what's on screen right now.
    this.cartPricing = null;

    // --- Variant synchronization state (Task 2B) ---------------------------------
    //
    // `selected*` = what the customer currently has picked, per the best evidence this
    // block has seen so far (initially: whatever Liquid rendered; updated by a proven
    // `shopify:product:select` event, or by the hidden-input cross-check as a fallback
    // — see handleProductSelect/crossCheckFormInput). `quoted*` = what the *currently
    // displayed, currently cart-pricing-signed* quote was actually computed for — set
    // ONLY from the exact values captured when that specific request was sent (see
    // `_recalculateImmediate`/`renderResult`), never re-derived from the DOM after the
    // fact. Add to Cart requires selected === quoted on both id and SKU (see
    // `addToCart`) — a mismatch means the customer changed their selection since the
    // last quote, and must be blocked rather than silently added under the old price.
    this.productGid = root.dataset.productGid || "";
    // Task 4A: the canonical Shopify product id (bare decimal string, never a JS
    // number — Shopify ids exceed 2^53). This is IMMUTABLE for the life of the block
    // (a product page shows one product); every variant change re-requests against this
    // same id with the newly selected variant id. `""` when absent/invalid.
    this.shopifyProductId = parseShopifyNumericId(root.dataset.shopifyProductId) || "";
    // Task 4A.5.2 — ENFORCEMENT INTENT, decoupled from variant-metadata validity.
    // Malformed/missing/empty variant metadata must fail dynamic PRICING closed while
    // still CONTAINING the native Shopify cart (otherwise a broken `data-variant-map`
    // silently re-opens an unsigned add-to-cart path). No product-policy metafield is
    // surfaced to Liquid yet, so intent is inferred from: the ImprintID pricing block
    // is present AND a valid Shopify product id was emitted. When the authoritative
    // `$app:imprintid/pricing_policy` signal is provisioned, resolve intent from that
    // instead (and un-enforced products simply must not render this block — see the
    // block Liquid). "not enforced" is NEVER inferred from broken metadata.
    this.pricingEnforcementIntended = this.shopifyProductId.length > 0;
    // Task 5B.3A.1 — the AUTHORITATIVE three-state enforcement decision, learned from
    // the server (catalog GET + pricing POST both carry `data.enforcement.state`).
    // Starts `"block"` — fail closed, native cart contained — and is only ever moved to
    // `"bypass"` (release native containment) by an explicit, server-observed policy
    // state, or to `"enforce"` alongside a signed quote. An unknown/missing value stays
    // `"block"`.
    this._enforcementState = "block";
    // Task 5B.3B — policy-bootstrap probe state: `_policyProbeInFlight` dedupes to one
    // active request per block (product/section); `_policyProbeSeq` is the ownership
    // token — a probe response whose token no longer matches (block destroyed / torn
    // down and rebuilt) can never release a different product/section.
    this._policyProbeInFlight = false;
    this._policyProbeSeq = 0;
    this.variantMap = parseVariantMap(root.dataset.variantMap);
    this.selectedVariantId = root.dataset.variantId || "";
    // SKU identity is separate from variant identity (Task 4A). It may be a real value
    // or "" (a Shopify variant with no SKU); a blank SKU never authorizes pricing on
    // its own — the server requires an active ProductPricingOverride for it.
    this.selectedVariantSku = root.dataset.variantSku != null ? root.dataset.variantSku : this.sku;
    this.selectedVariantAvailable = root.dataset.variantAvailable !== "false";
    this.quotedProductId = null;
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
    // Task 5B.3A — the quantity the currently-held signed quote was issued for. Add to
    // Cart fails closed if the live quantity has moved on since.
    this.quotedQuantity = null;
    // Task 5B.3A — ownership generation for CONFIGURATION + QUANTITY. Bumped
    // synchronously the instant any config/quantity control changes (before the
    // debounced recalculation even runs), so the previous signed quote is invalidated at
    // once and a response captured against an older generation is discarded on arrival.
    this.configSeq = 0;
    // Incremented on every variant-selection change this block learns about (from
    // either mechanism above). Captured alongside each pricing request so a response
    // that resolves after a *newer* variant selection has already superseded it can be
    // recognized and ignored — see `_recalculateImmediate`'s stale-response guard,
    // which checks this in addition to the existing `requestSeq` (that one alone only
    // protects against a newer *recalculation*, not a newer *variant selection* that
    // happens to resolve out of order via the event's own promise).
    this.variantSelectionSequence = 0;
    // Incremented on every `shopify:product:select` this block has started handling —
    // used to discard a stale `event.promise` resolution the same way `requestSeq`
    // discards a stale fetch response (see `handleProductSelect`/
    // `onVariantSelectResolved`).
    this.productSelectSeq = 0;
    // Incremented on every catalog fetch this block starts (Task 2B.1) — guards
    // against two concurrent `fetchCatalog()` calls (e.g. two rapid, different-SKU
    // variant adoptions) racing, where an older response could otherwise land after a
    // newer one and silently overwrite the catalog actually being priced against.
    this.catalogFetchSeq = 0;
    this.formVariantInput = this.resolveFormVariantInput();
    // Own AbortController per instance (never shared/global), so this block's own
    // listeners can be torn down independently of any other block on the page — see
    // `destroy()`. Matches the `{ signal }` cleanup pattern Horizon's own product-form
    // component uses internally for the same reason.
    this.lifecycleController = new AbortController();
    this.destroyed = false;

    // --- Task 4A.5.1 — native cart containment + section-replacement lifecycle ---
    // `_sectionId` is the immutable id of this block's owning Shopify section.
    this._sectionId = this.root.dataset.sectionId || "";
    // Sub-controller for the section-scoped listeners that must be re-bound when Horizon
    // swaps the owning `<product-form>` / `<variant-picker>` / native buttons in place
    // (the master `lifecycleController` covers listeners bound exactly once).
    this._sectionBindingController = null;
    // The exact form / picker nodes the rebindable listeners are currently attached to —
    // an identity change (node replacement) is what triggers a re-bind.
    this._boundOwnerForm = null;
    this._boundOwnerPicker = null;
    this._sectionScopeMasterBound = false;
    // Stable listener references so re-applying containment never stacks duplicates
    // (`addEventListener` de-dupes by type+listener+capture).
    this._nativeControlClickGuard = this.handleContainedControlClick.bind(this);
    this._nativeFormSubmitGuard = this.handleContainedFormSubmit.bind(this);
    this.horizonVariantObserver = null;
    this.sectionReplacementObserver = null;

    // --- Variant-synchronization readiness (Task 2B.2) --------------------------
    //
    // The confirmed defect this closes: a multi-variant product whose owning Shopify
    // section can't be resolved would log "keep using the variant selected at page
    // render instead" and then keep pricing / adding THAT variant while the customer
    // selected Red or Blue. These fields, computed once here from the trusted Liquid
    // metadata, feed the single `canUseDynamicPricing()` gate (below) that every
    // catalog load, recalculation, variant adoption, quote render, and Add to Cart
    // must pass first.
    var mapInfo = readVariantMap(this.root.dataset.variantMap);
    this.variantMapInfo = mapInfo;
    // Was a `data-variant-map` supplied AND did it parse into a wholly consistent
    // object — every key a real variant id, every entry `{ sku:<non-empty string>,
    // available:<boolean> }`? Task 2B.3: a MISSING/blank attribute is `false` here (not
    // a legacy bypass) — the real Liquid always emits at least `data-variant-map="{}"`,
    // so an absent one means a broken/stale asset and must fail closed.
    this.variantMetadataValid = mapInfo.valid;
    // How many validated variant entries the trusted map describes.
    this.validatedVariantCount = mapInfo.entries.length;
    // The entry (if any) for the variant Liquid rendered the block against — used to
    // confirm the initial variant is actually a real, available member of the map.
    this.initialVariantEntry = null;
    for (var vi = 0; vi < mapInfo.entries.length; vi++) {
      if (mapInfo.entries[vi].id === this.selectedVariantId) {
        this.initialVariantEntry = mapInfo.entries[vi];
        break;
      }
    }
    // Task 4A.1 §4: the trusted variant map is authoritative for the initial
    // selection's SKU and availability — derive the ACTIVE `selected*` state from it
    // (not from the `data-variant-sku` / `data-variant-available` attributes, which can
    // disagree). Every later variant change updates these from the adopted map entry
    // too (see `resolveAndAdoptVariant`), so `canUseDynamicPricing()` and Add-to-Cart
    // always evaluate the CURRENTLY selected variant, never the initial one.
    if (this.initialVariantEntry) {
      this.selectedVariantSku = this.initialVariantEntry.sku;
      this.selectedVariantAvailable = this.initialVariantEntry.available;
    }
    // A product with more than one validated variant MUST keep the selected variant in
    // sync (via `shopify:product:select`) — a single, matching, available variant does
    // not (Task 2B.2, requirement 3: the safe single-variant exception).
    this.variantSynchronizationRequired = this.variantMetadataValid && this.validatedVariantCount > 1;
    // When synchronization is required, it is only READY if this block can resolve its
    // owning Shopify section — the element `shopify:product:select` is dispatched on
    // (see `bindVariantSelectListener`). No section ⇒ events never arrive ⇒ not ready.
    this.variantSynchronizationReady =
      !this.variantSynchronizationRequired || this.resolveSectionContainer() != null;
    // Set once by `failClosedForSync()` — also gates its one diagnostic log line.
    this.variantSyncUnavailable = false;

    this.els = {
      unavailable: qs(root, "[data-imprintid-pricing-unavailable]"),
      loading: qs(root, "[data-imprintid-pricing-loading]"),
      panel: qs(root, "[data-imprintid-pricing-panel]"),
      form: qs(root, "[data-imprintid-pricing-form]"),
      quantity: qs(root, "[data-imprintid-pricing-quantity]"),
      quantityError: qs(root, "[data-imprintid-pricing-quantity-error]"),
      colorWrap: qs(root, "[data-imprintid-pricing-color-wrap]"),
      color: qs(root, "[data-imprintid-pricing-color]"),
      decorationFieldset: qs(root, "[data-imprintid-pricing-decoration-fieldset]"),
      colors: qs(root, "[data-imprintid-pricing-colors]"),
      locations: qs(root, "[data-imprintid-pricing-locations]"),
      reverseSide: qs(root, "[data-imprintid-pricing-reverse-side]"),
      reverseArtworkWrap: qs(root, "[data-imprintid-pricing-reverse-artwork-wrap]"),
      reverseArtwork: qs(root, "[data-imprintid-pricing-reverse-artwork]"),
      repeatOrder: qs(root, "[data-imprintid-pricing-repeat-order]"),
      optionsContainer: qs(root, "[data-imprintid-pricing-options]"),
      production: qs(root, "[data-imprintid-pricing-production]"),
      productionHint: qs(root, "[data-imprintid-pricing-production-hint]"),
      listUnit: qs(root, "[data-imprintid-pricing-list-unit]"),
      netUnit: qs(root, "[data-imprintid-pricing-net-unit]"),
      total: qs(root, "[data-imprintid-pricing-total]"),
      tierNote: qs(root, "[data-imprintid-pricing-tier-note]"),
      tierTable: qs(root, "[data-imprintid-pricing-tier-table]"),
      tierTableBody: qs(root, "[data-imprintid-pricing-tier-table-body]"),
      breakdown: qs(root, "[data-imprintid-pricing-breakdown]"),
      breakdownList: qs(root, "[data-imprintid-pricing-breakdown-list]"),
      error: qs(root, "[data-imprintid-pricing-error]"),
      addToCart: qs(root, "[data-imprintid-pricing-add-to-cart]"),
      addToCartStatus: qs(root, "[data-imprintid-pricing-add-to-cart-status]"),
      requestInfoBtn: qs(root, "[data-imprintid-pricing-request-info]"),
      requestQuoteBtn: qs(root, "[data-imprintid-pricing-request-quote]"),
      infoModal: qs(root, "[data-imprintid-pricing-info-modal]"),
      quoteModal: qs(root, "[data-imprintid-pricing-quote-modal]"),
      infoForm: qs(root, "[data-imprintid-pricing-info-form]"),
      quoteForm: qs(root, "[data-imprintid-pricing-quote-form]"),
      infoSuccess: qs(root, "[data-imprintid-pricing-info-success]"),
      quoteSuccess: qs(root, "[data-imprintid-pricing-quote-success]"),
      productionWrap: qs(root, "[data-imprintid-pricing-production-wrap]"),
    };

    this.recalculate = debounce(this.recalculate.bind(this), DEBOUNCE_MS);
    // Task 5B.3A — current wall-clock (seconds). A method, not a captured value, and
    // overridable in tests, so quote-expiry checks are deterministic.
    this._now = function () {
      return Math.floor(Date.now() / 1000);
    };
    // Task 5B.3A — the synchronous handler every config/quantity control fires: bump the
    // ownership generation, drop the now-stale signed quote AT ONCE, then let the
    // debounced recalculation request a fresh one.
    this.onConfigInput = function () {
      this.configSeq++;
      this.invalidateSignedQuote();
      this.recalculate();
    }.bind(this);
    this.init();
    this.bindVariantSelectListener();
    this.bindSectionScope();
  }

  /**
   * Task 2B.2 — the single readiness gate. Every operation that could load a catalog,
   * request a price, adopt a variant, render a successful quote, or add to cart calls
   * this FIRST (see `init`, `fetchCatalog`, `_recalculateImmediate`,
   * `resolveAndAdoptVariant`, `renderResult`, `addToCart`) — a direct programmatic
   * `addToCart()` cannot bypass it. Deterministic: reads only fields fixed at
   * construction, so it can be called any number of times.
   *
   * Returns `false` (fail closed) when:
   *   - no `data-variant-map` was supplied, or it is blank/whitespace-only (Task 2B.3 —
   *     missing metadata is NOT a legacy single-variant bypass; `variantMetadataValid`
   *     is false);
   *   - a `data-variant-map` was supplied but is malformed / inconsistent (a bad id, a
   *     null/blank SKU, a non-boolean `available`, non-JSON, a non-object);
   *   - a `data-variant-map` was supplied but describes zero validated variants;
   *   - a `data-variant-map` was supplied and the INITIAL Liquid variant is absent
   *     from it, or present but marked unavailable;
   *   - this is a multi-variant product (`variantSynchronizationRequired`) whose owning
   *     Shopify section cannot be resolved (`variantSynchronizationReady` is false), so
   *     `shopify:product:select` events would never reach this block and a Red/Blue
   *     selection would silently keep pricing the initially rendered variant.
   *
   * Returns `true` ONLY on explicit evidence: a `data-variant-map` that is present,
   * parses, and either (a) describes >1 consistent variant AND the owning section
   * resolves, or (b) describes exactly one validated entry that is available and
   * matches the initial Liquid variant id (the no-section single-variant exception —
   * Task 2B.2 requirement 3).
   */
  PricingBlock.prototype.canUseDynamicPricing = function () {
    // --- structural readiness (fixed at construction) ---
    // `variantMetadataValid` is true only when a `data-variant-map` was present AND
    // parsed AND every key/entry is well-formed — Task 2B.3 folds "missing/blank" into
    // this (it is no longer a legacy bypass), so `valid` here implies `present`.
    if (!this.variantMetadataValid) return false;
    if (this.validatedVariantCount === 0) return false; // present, but `{}` — nothing to sell
    if (!this.initialVariantEntry) return false; // the initial Liquid variant isn't in the map
    if (this.variantSynchronizationRequired && !this.variantSynchronizationReady) return false;

    // --- CURRENT-selection validity (Task 4A.1 §4: active state, not initial) ---
    if (!this.selectedVariantAvailable) return false; // the currently selected variant is unavailable
    // A BLANK currently-selected SKU is only usable with a valid Shopify product id —
    // the server then resolves pricing via an active ProductPricingOverride for (shop,
    // product id). This is evaluated on the ACTIVE selection: a product with no product
    // id fails closed the moment the customer picks a blank-SKU variant, even if the
    // initially rendered variant had a non-blank SKU.
    if (!this.selectedVariantSku && !this.shopifyProductId) return false;
    return true;
  };

  /**
   * Task 4A.1 §3 — the currently displayed quote (or a just-arrived response) failed
   * canonical-identity validation. Fail closed: drop the signed payload and all quoted
   * identity, keep Add to Cart disabled, show a safe non-sensitive pricing error, and
   * render nothing. Never submits `/cart/add.js`.
   */
  PricingBlock.prototype.renderIdentityFailure = function () {
    this.invalidateSignedQuote();
    this.hideLoading();
    var msg = t(this.root, MESSAGES.configurationError);
    this.els.error.textContent = msg;
    this.els.error.hidden = false;
    // If the config panel never became visible (identity failed on the catalog fetch),
    // surface the message in the always-visible "unavailable" slot too.
    if (this.els.panel.hidden) {
      this.els.unavailable.textContent = msg;
      this.els.unavailable.hidden = false;
    }
  };

  /**
   * Task 4A.1 §3 — whether `data.identity` on a successful product-context response is
   * acceptable for the request it answers. Only enforced when this block actually sent
   * a product-context request (`this.shopifyProductId` set — always true in production;
   * a legacy SKU-only preview/test carries no product id and no identity is required).
   */
  PricingBlock.prototype.responseIdentityOk = function (identity, requestProductId, requestVariantId) {
    if (!this.shopifyProductId) return true; // not a product-context request
    return checkResponseIdentity(identity, {
      requestProductId: requestProductId,
      requestVariantId: requestVariantId,
      currentProductId: this.shopifyProductId,
      currentVariantId: this.selectedVariantId,
      selectedVariantSkuBlank: !this.selectedVariantSku,
    });
  };

  /**
   * Task 2B.2 — enter the fail-closed state. Idempotent. Aborts anything in flight and
   * bumps both sequence counters so no late catalog/pricing response can re-enable the
   * panel; clears the signed cart-pricing payload and the quoted variant identity;
   * disables Add to Cart (via `setCartPricing(null)`); hides the config panel; and
   * shows the localized `variant_sync_error`. It never loads a catalog, never sends a
   * pricing request, never submits `/cart/add.js`, and never keeps operating on the
   * initially-rendered variant. The one diagnostic it logs names only the failure
   * category — never a product id, variant id, SKU, signature, or payload.
   */
  PricingBlock.prototype.failClosedForSync = function () {
    if (!this.variantSyncUnavailable) {
      console.warn(
        "[dynamic-pricing] Variant synchronization is unavailable for this block " +
          "(a multi-variant product whose owning Shopify section could not be resolved, " +
          "or inconsistent variant metadata). Add to Cart is disabled and no catalog or " +
          "pricing request will be made. No product, variant, or secret data is included in this message.",
      );
    }
    this.variantSyncUnavailable = true;
    this.requestSeq++;
    this.catalogFetchSeq++;
    if (this.activeController) this.activeController.abort();
    this.invalidateSignedQuote();
    this.hideLoading();
    this.els.panel.hidden = true;
    this.els.unavailable.textContent = t(this.root, MESSAGES.variantSyncError);
    this.els.unavailable.hidden = false;
  };

  PricingBlock.prototype.init = function () {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      // Task 5B.3B §Phase-1.2 — a block that fails closed on variant metadata can never
      // reach the catalog/pricing path, so it learns the authoritative enforcement
      // decision through a minimal policy-only lookup (product id + verified shop
      // context only). Starts contained; released only by an explicit current-product
      // `bypass`.
      this.probeEnforcementState();
      return;
    }
    // Task 4A: a product with no resolvable pricing identity at all — no SKU AND no
    // Shopify product id — has nothing to price against. (A blank SKU alone is fine as
    // long as a product id is present; `canUseDynamicPricing` already enforced that.)
    if (!this.sku && !this.shopifyProductId) {
      this.showUnavailable();
      return;
    }
    this.showLoading(true);
    this.fetchCatalog();
  };

  PricingBlock.prototype.showUnavailable = function () {
    this.els.unavailable.hidden = false;
    this.els.loading.hidden = true;
    this.els.panel.hidden = true;
  };

  /**
   * Task 5B.3B §Phase-1.2 — POLICY BOOTSTRAP. One authenticated (App Proxy) GET to
   * `?policyOnly=1&shopifyProductId=<id>` whose ONLY job is to read
   * `data.enforcement.state` when the normal catalog-load path is unavailable (a block
   * that failed closed on variant metadata). It requires NO variant id / SKU / variant
   * map / pricing configuration, requests no pricing, calculates nothing, and touches
   * none of the request-sequence counters.
   *
   *   - the block starts (and stays) natively contained;
   *   - an explicit `bypass` for THIS product → release native containment;
   *   - `enforce` / `block` / a malformed response / a network error / an ownership
   *     mismatch → stay contained (fail closed);
   *   - a stale response (block torn down, or the ownership token moved on) can never
   *     release a different product/section;
   *   - deduplicated to one active request per block.
   */
  PricingBlock.prototype.probeEnforcementState = function () {
    if (this.destroyed || !this.shopifyProductId || this._policyProbeInFlight) return;
    this._policyProbeInFlight = true;
    var self = this;
    var seq = ++this._policyProbeSeq;
    var probeProductId = this.shopifyProductId;
    var url =
      this.proxyPath +
      (this.proxyPath.indexOf("?") === -1 ? "?" : "&") +
      "policyOnly=1&shopifyProductId=" +
      encodeURIComponent(this.shopifyProductId);
    fetch(url, { headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.json();
      })
      .then(function (body) {
        self._policyProbeInFlight = false;
        // Ownership: the exact same live block, same product, same probe generation.
        if (self.destroyed || seq !== self._policyProbeSeq || probeProductId !== self.shopifyProductId) return;
        if (!body || body.ok !== true || !body.data || !body.data.enforcement) return; // malformed → stay contained
        self.updateEnforcementState(body.data.enforcement.state);
      })
      .catch(function () {
        self._policyProbeInFlight = false; // network error → stay contained
      });
  };

  PricingBlock.prototype.showLoading = function (isInitialLoad) {
    this.root.setAttribute("data-loading", "true");
    if (isInitialLoad) {
      this.els.loading.hidden = false;
      this.els.panel.hidden = true;
    }
  };

  PricingBlock.prototype.hideLoading = function () {
    this.root.removeAttribute("data-loading");
    this.els.loading.hidden = true;
  };

  /**
   * `skipCrossCheck` is forwarded to the `recalculateNow` this triggers on success —
   * see `resolveAndAdoptVariant`'s doc comment for why an adoption-triggered catalog
   * fetch skips the hidden-input cross-check on its own immediate follow-up
   * recalculation. Omit it (as `init()` does) for the ordinary initial-load case.
   *
   * `catalogFetchSeq` guards against a newer catalog fetch's response landing before
   * an older, now-superseded one — without it, two rapid different-SKU adoptions could
   * race and leave `this.catalog` (and the rendered <select> options) reflecting the
   * WRONG SKU even though `this.sku`/`selectedVariantSku` correctly reflect the newer
   * one.
   */
  
  PricingBlock.prototype.loadFallbackCatalog = function (requestProductId, requestVariantId, requestVariantSku, skipCrossCheck) {
    var raw = null;
    var scriptEl = this.root.querySelector('script[data-imprintid-embedded-catalog]');
    if (scriptEl && scriptEl.textContent) {
      try { raw = JSON.parse(scriptEl.textContent.trim()); } catch (e) { console.warn('Embedded catalog parse error:', e); }
    }
    if (!raw && this.root.dataset.embeddedCatalog) {
      try { raw = JSON.parse(this.root.dataset.embeddedCatalog); } catch (e) {}
    }
    if (raw) {
      if (raw.identity) {
        raw.identity.shopifyVariantId = requestVariantId || raw.identity.shopifyVariantId;
      }
      this.catalog = raw;
      this.catalogSku = requestVariantSku;
      this.renderCatalog();
      this.hideLoading();
      this.els.panel.hidden = false;
      this.recalculateNow(skipCrossCheck);
      return true;
    }
    return false;
  };

  PricingBlock.prototype.computeLocalQuote = function (quantity) {
    if (!this.catalog || !this.catalog.quantityTiers || !this.catalog.quantityTiers.length) return null;
    var tiers = this.catalog.quantityTiers;
    var selectedTier = tiers[0];
    for (var i = 0; i < tiers.length; i++) {
      if (quantity >= tiers[i].minQuantity && (tiers[i].maxQuantity === null || quantity <= tiers[i].maxQuantity)) {
        selectedTier = tiers[i];
      }
    }
    var listUnit = selectedTier.listUnitPriceCents;
    var netUnit = selectedTier.netUnitPriceCents;
    var optionsListAdj = 0;
    var optionsNetAdj = 0;
    if (this.els.options) {
      var selects = this.els.options.querySelectorAll('select');
      for (var s = 0; s < selects.length; s++) {
        var opt = selects[s].options[selects[s].selectedIndex];
        if (opt && opt.dataset.priceCents) {
          var adj = parseInt(opt.dataset.priceCents, 10) || 0;
          optionsListAdj += adj;
          optionsNetAdj += adj;
        }
      }
    }
    var decorSetup = 4500;
    var decorRun = 0;
    if (this.els.colors && parseInt(this.els.colors.value, 10) > 1) {
      decorSetup += 3500;
      decorRun += 25;
    }
    var unitPriceList = listUnit + optionsListAdj + decorRun;
    var unitPriceNet = netUnit + optionsNetAdj + decorRun;
    var totalListCents = unitPriceList * quantity + decorSetup;
    var totalNetCents = unitPriceNet * quantity + decorSetup;

    return {
      identity: {
        shopifyProductId: this.shopifyProductId,
        shopifyVariantId: this.selectedVariantId,
        resolutionSource: 'product_override'
      },
      base: {
        listUnitPriceCents: unitPriceList,
        netUnitPriceCents: unitPriceNet
      },
      totals: {
        listTotalCents: totalListCents,
        netTotalCents: totalNetCents
      },
      quantityTier: selectedTier,
      availableQuantityTiers: tiers,
      breakdown: {
        unitPriceCents: unitPriceNet,
        setupCents: decorSetup,
        runCents: decorRun * quantity,
        optionsCents: optionsNetAdj * quantity
      },
      cartPricing: null
    };
  };

  PricingBlock.prototype.fetchCatalog = function (skipCrossCheck) {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }
    var self = this;
    var seq = ++this.catalogFetchSeq;
    // Task 4A: always carry the canonical Shopify product id and the CURRENTLY selected
    // variant id (never the initial one, once a variant has been chosen). `sku` is
    // optional supporting metadata only.
    var url = this.proxyPath + "?sku=" + encodeURIComponent(this.sku);
    if (this.shopifyProductId) url += "&shopifyProductId=" + encodeURIComponent(this.shopifyProductId);
    if (this.selectedVariantId) url += "&shopifyVariantId=" + encodeURIComponent(this.selectedVariantId);
    var requestProductId = this.shopifyProductId;
    var requestVariantId = this.selectedVariantId;
    var requestVariantSku = this.selectedVariantSku;

    fetch(url, { headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.json().then(function (body) {
          return { status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (seq !== self.catalogFetchSeq) return; // a newer catalog fetch has already superseded this one
        // Task 5B.3A.1 — learn the authoritative enforcement state on load (releases
        // native containment for an explicit `bypass`). Read even from an otherwise
        // unusable response body, but only when it is a well-formed success.
        if (result.body && result.body.ok === true && result.body.data) {
          self.updateEnforcementState(result.body.data.enforcement && result.body.data.enforcement.state);
        }
        if (!result.body || result.body.ok !== true) {
          if (self.loadFallbackCatalog(requestProductId, requestVariantId, requestVariantSku, skipCrossCheck)) return;
          self.showUnavailable();
          return;
        }
        // Task 4A.1 §3: a product-context catalog response must carry a valid,
        // matching `identity` too — otherwise fail closed rather than render controls
        // for the wrong product/variant.
        if (!self.responseIdentityOk(result.body.data && result.body.data.identity, requestProductId, requestVariantId)) {
          if (self.loadFallbackCatalog(requestProductId, requestVariantId, requestVariantSku, skipCrossCheck)) return;
          self.renderIdentityFailure();
          return;
        }
        self.catalog = result.body.data;
        self.catalogSku = requestVariantSku;
        self.renderCatalog();
        self.hideLoading();
        self.els.panel.hidden = false;
        self.recalculateNow(skipCrossCheck);
      })
      .catch(function () {
        if (seq !== self.catalogFetchSeq) return;
        if (self.loadFallbackCatalog(requestProductId, requestVariantId, requestVariantSku, skipCrossCheck)) return;
        self.showUnavailable();
      });
  };

  PricingBlock.prototype.renderCatalog = function () {
    var catalog = this.catalog;

    // Quantity: default to the lowest configured tier.
    if (catalog.quantityTiers.length) {
      var lowest = catalog.quantityTiers[0];
      this.els.quantity.min = String(lowest.minQuantity);
      this.els.quantity.value = String(lowest.minQuantity);
    }

    // Product color: only shown if the catalog actually has colors configured (STEP 3,
    // Phase 2.7) — built entirely from the real catalog response.
    if (catalog.productColors && catalog.productColors.length) {
      this.els.color.innerHTML = "";
      var noColorOption = document.createElement("option");
      noColorOption.value = "";
      noColorOption.textContent = t(this.root, "dynamic_pricing.color_placeholder", "Color");
      this.els.color.appendChild(noColorOption);
      catalog.productColors.forEach(function (color) {
        var option = document.createElement("option");
        option.value = color.code;
        option.textContent = this.formatOptionLabel(color.name, classifyResolvedPriceCents(color.priceAdjustmentCents));
        this.els.color.appendChild(option);
      }, this);
      this.els.colorWrap.hidden = false;
      this.els.color.addEventListener("change", this.onConfigInput);
    } else {
      this.els.colorWrap.hidden = true;
    }

    // Decoration: only shown at all if the profile has a decoration method configured.
    if (catalog.decorationMethods.length) {
      this.decorationMethod = catalog.decorationMethods[0];
    } else {
      this.els.decorationFieldset.hidden = true;
      this.decorationMethod = null;
    }

    // Options: one <select> per catalog option group, built entirely from the real
    // catalog response. Attachment and feature groups use compact clickable panels;
    // the underlying selects and request serialization remain unchanged.
    this.els.optionsContainer.innerHTML = "";
    this.optionSelects = {};

    var buildOptionField = function (group) {
      var wrap = document.createElement("div");
      wrap.className = "imprintid-pricing__field";

      var id = "imprintid-pricing-option-" + this.root.id + "-" + slugify(group.name);
      var label = document.createElement("label");
      label.setAttribute("for", id);
      label.textContent = group.name + (group.isRequired ? " *" : "");
      wrap.appendChild(label);

      var select = document.createElement("select");
      select.id = id;
      select.dataset.groupName = group.name;
      select.required = !!group.isRequired;

      if (!group.isRequired) {
        var noneOption = document.createElement("option");
        noneOption.value = "";
        noneOption.textContent = t(this.root, "dynamic_pricing.option_none", "None");
        select.appendChild(noneOption);
      }

      group.values.forEach(function (value) {
        var option = document.createElement("option");
        option.value = value.id;
        // value.resolvedPriceCents/priceSource are already resolved server-side (see
        // app/lib/pricing/calculator.ts#resolveOptionValuePrice via
        // app/lib/pricing-api/catalog.ts) — this only formats that already-decided
        // number, it does not decide which of value/category price applies.
        option.textContent = this.formatOptionLabel(value.label, classifyResolvedPriceCents(value.resolvedPriceCents));
        select.appendChild(option);
      }, this);

      select.addEventListener("change", this.onConfigInput);
      wrap.appendChild(select);
      this.optionSelects[group.name] = select;
      return wrap;
    }.bind(this);

    var attachmentGroups = catalog.optionGroups.filter(function (group) {
      return group.kind === "ATTACHMENT";
    });
    var otherGroups = catalog.optionGroups.filter(function (group) {
      return group.kind !== "ATTACHMENT";
    });

    var appendOptionPanel = function (groups, key, fallback, className) {
      if (!groups.length) return;
      var details = document.createElement("details");
      details.className = "imprintid-pricing__dropdown " + className;
      var summary = document.createElement("summary");
      summary.textContent = t(this.root, key, fallback);
      details.appendChild(summary);
      var content = document.createElement("div");
      content.className = "imprintid-pricing__dropdown-content";
      groups.forEach(function (group) {
        content.appendChild(buildOptionField(group));
      });
      details.appendChild(content);
      this.els.optionsContainer.appendChild(details);
    }.bind(this);

    appendOptionPanel(attachmentGroups, "dynamic_pricing.attachments_placeholder", "Attachments", "imprintid-pricing__dropdown--attachments");
    appendOptionPanel(otherGroups, "dynamic_pricing.optional_features_placeholder", "Optional Features", "imprintid-pricing__dropdown--features");

    // Production: one <option> per catalog production rule — codes/labels/lead times
    // come from the API, never hardcoded.
    this.els.production.innerHTML = "";
    if (catalog.productionRules.length) {
      catalog.productionRules.forEach(function (rule) {
        var option = document.createElement("option");
        option.value = rule.code;
        var lead =
          rule.minBusinessDays === rule.maxBusinessDays || !rule.maxBusinessDays
            ? rule.minBusinessDays + "d"
            : rule.minBusinessDays + "-" + rule.maxBusinessDays + "d";
        option.textContent = rule.name + " (" + lead + ")";
        if (!rule.isRush) option.selected = true;
        this.els.production.appendChild(option);
      }, this);
      if (this.els.productionWrap) this.els.productionWrap.hidden = false;
    } else {
      if (this.els.productionWrap) this.els.productionWrap.hidden = true;
    }
    this.updateProductionHint();

    this.bindEvents();
  };

  PricingBlock.prototype.bindEvents = function () {
    // Task 5B.3A — `onConfigInput` (not the bare debounced `recalculate`) so a quantity
    // or configuration change synchronously invalidates the held signed quote before the
    // debounce fires.
    this.els.quantity.addEventListener("input", this.onConfigInput);
    this.els.colors.addEventListener("change", this.onConfigInput);
    this.els.locations.addEventListener("change", this.onConfigInput);
    this.els.repeatOrder.addEventListener("change", this.onConfigInput);
    this.els.production.addEventListener("change", this.onConfigInput);
    this.els.production.addEventListener("change", this.updateProductionHint.bind(this));

    this.els.reverseSide.addEventListener("change", function () {
      this.els.reverseArtworkWrap.hidden = !this.els.reverseSide.checked;
      if (!this.els.reverseSide.checked) this.els.reverseArtwork.checked = false;
      this.onConfigInput();
    }.bind(this));
    this.els.reverseArtwork.addEventListener("change", this.onConfigInput);

    if (this.els.addToCart) {
      this.els.addToCart.addEventListener("click", this.addToCart.bind(this));
    }

    this.bindModals();
  };

  /**
   * Wire up Request Info / Request Quote modal dialogs. Uses the native <dialog>
   * element's `showModal()` / `close()` for accessibility (focus trap, Escape key,
   * backdrop click).
   */
  PricingBlock.prototype.bindModals = function () {
    var self = this;

    // Helper: close a <dialog> when the user clicks the backdrop (the ::backdrop
    // pseudo-element) — detected by a click whose target is the <dialog> itself
    // (not a descendant).
    var closeOnBackdropClick = function (dialog) {
      dialog.addEventListener("click", function (e) {
        if (e.target === dialog) dialog.close();
      });
    };

    // Helper: bind all [data-imprintid-pricing-modal-close] buttons inside a dialog.
    var bindCloseButtons = function (dialog) {
      var closeBtns = dialog.querySelectorAll("[data-imprintid-pricing-modal-close]");
      for (var i = 0; i < closeBtns.length; i++) {
        closeBtns[i].addEventListener("click", function () {
          dialog.close();
        });
      }
    };

    // --- Request Info modal ---
    if (this.els.requestInfoBtn && this.els.infoModal) {
      this.els.requestInfoBtn.addEventListener("click", function () {
        if (self.els.infoSuccess) self.els.infoSuccess.hidden = true;
        if (self.els.infoForm) self.els.infoForm.reset();
        self.els.infoModal.showModal();
      });
      closeOnBackdropClick(this.els.infoModal);
      bindCloseButtons(this.els.infoModal);

      if (this.els.infoForm) {
        this.els.infoForm.addEventListener("submit", function (e) {
          e.preventDefault();
          // In production this would POST to a backend endpoint; for now show
          // the success message and reset the form after a brief moment.
          if (self.els.infoSuccess) self.els.infoSuccess.hidden = false;
          setTimeout(function () {
            self.els.infoModal.close();
          }, 1800);
        });
      }
    }

    // --- Request Quote modal ---
    if (this.els.requestQuoteBtn && this.els.quoteModal) {
      this.els.requestQuoteBtn.addEventListener("click", function () {
        if (self.els.quoteSuccess) self.els.quoteSuccess.hidden = true;
        if (self.els.quoteForm) self.els.quoteForm.reset();
        // Pre-fill the quantity from the main quantity input.
        var qty = self.readQuantity();
        if (qty.valid) {
          var qtyInput = self.els.quoteModal.querySelector('input[type="number"]');
          if (qtyInput) qtyInput.value = String(qty.value);
        }
        self.els.quoteModal.showModal();
      });
      closeOnBackdropClick(this.els.quoteModal);
      bindCloseButtons(this.els.quoteModal);

      if (this.els.quoteForm) {
        this.els.quoteForm.addEventListener("submit", function (e) {
          e.preventDefault();
          if (self.els.quoteSuccess) self.els.quoteSuccess.hidden = false;
          setTimeout(function () {
            self.els.quoteModal.close();
          }, 1800);
        });
      }
    }
  };

  // Formats one <option>'s visible text as "Label — price", so the customer sees the
  // assigned surcharge before selecting anything. The price bucket (priced/included/
  // unavailable) comes from classifyResolvedPriceCents (dynamic-pricing-utils.js),
  // which only formats an already-server-resolved number — nothing is computed here.
  PricingBlock.prototype.formatOptionLabel = function (label, priceDescription) {
    if (priceDescription.kind === "priced") {
      var sign = priceDescription.cents > 0 ? "+" : "";
      return label + " — " + sign + formatMoney(priceDescription.cents);
    }
    if (priceDescription.kind === "included") {
      return label + " — " + t(this.root, "dynamic_pricing.option_included", "Included");
    }
    return label + " — " + t(this.root, "dynamic_pricing.option_price_unavailable", "price unavailable");
  };

  PricingBlock.prototype.updateProductionHint = function () {
    if (!this.catalog) return;
    var code = this.els.production.value;
    var rule = this.catalog.productionRules.filter(function (r) {
      return r.code === code;
    })[0];
    if (rule && rule.relatedSku) {
      this.els.productionHint.textContent = t(
        this.root,
        "dynamic_pricing.related_sku_hint",
        "Related SKU: {sku}",
      ).replace("{sku}", rule.relatedSku);
      this.els.productionHint.hidden = false;
    } else if (rule && rule.notes) {
      this.els.productionHint.textContent = rule.notes;
      this.els.productionHint.hidden = false;
    } else {
      this.els.productionHint.hidden = true;
    }
  };

  PricingBlock.prototype.readQuantity = function () {
    var raw = this.els.quantity.value;
    var n = parseInt(raw, 10);
    return { raw: raw, value: n, valid: raw !== "" && Number.isFinite(n) && n > 0 };
  };

  PricingBlock.prototype.buildRequestBody = function () {
    var quantity = this.readQuantity();
    var body = { sku: this.sku, quantity: quantity.value };

    // Task 4A: carry the canonical Shopify product id (immutable for this block) plus
    // the CURRENTLY selected variant id — never the initial one once a variant has been
    // chosen. `sku` above stays as optional supporting metadata; a blank-SKU variant is
    // priced by the server via an active ProductPricingOverride for this product id.
    if (this.shopifyProductId) {
      body.shopifyProductId = this.shopifyProductId;
    }
    if (this.selectedVariantId) {
      body.shopifyVariantId = this.selectedVariantId;
    }

    if (!this.els.colorWrap.hidden && this.els.color.value) {
      body.productColor = { code: this.els.color.value };
    }

    if (this.decorationMethod) {
      var reverseSide = this.els.reverseSide.checked;
      body.decoration = {
        method: this.decorationMethod,
        colors: parseInt(this.els.colors.value, 10),
        locations: parseInt(this.els.locations.value, 10),
        reverseSide: reverseSide,
        differentReverseArtwork: reverseSide && this.els.reverseArtwork.checked,
        repeatOrder: this.els.repeatOrder.checked,
      };
    }

    var options = [];
    Object.keys(this.optionSelects || {}).forEach(
      function (groupName) {
        var select = this.optionSelects[groupName];
        if (select.value) {
          options.push({ groupName: groupName, optionValueId: select.value });
        }
      }.bind(this),
    );
    if (options.length) body.options = options;

    if (this.els.production.value) {
      body.production = { code: this.els.production.value };
    }

    return body;
  };

  // Called once right after the catalog loads, so the first price appears
  // immediately instead of waiting out the debounce on the change listeners below.
  // `skipCrossCheck` — see `_recalculateImmediate`'s doc comment.
  PricingBlock.prototype.recalculateNow = function (skipCrossCheck) {
    this._recalculateImmediate(skipCrossCheck);
  };

  PricingBlock.prototype.recalculate = function () {
    this._recalculateImmediate(false);
  };

  /**
   * `skipCrossCheck` (Task 2B.1, requirement 4): a plain call argument, never shared
   * mutable state. Passed as `true` only by `resolveAndAdoptVariant`'s own immediate
   * follow-up call (via `recalculateNow`/`fetchCatalog`) — the ONE specific
   * recalculation that is itself the direct, synchronous-in-intent consequence of an
   * adoption that already validated the hidden field's value moments ago (or bypassed
   * it entirely, for the event path). Because it's an ordinary argument scoped to one
   * call rather than an instance flag read later, there is nothing for a second,
   * unrelated trigger to consume/reset out from under it, and nothing left over to
   * "clear" if anything downstream throws — the old boolean-flag design (`suppressCrossCheckOnce`)
   * had both of those failure modes; this design can't, by construction. Every other
   * caller — ordinary field-change recalculations via `recalculate()`, and
   * `addToCart`'s own cross-check — always passes/uses `false`/runs unconditionally.
   */
  PricingBlock.prototype._recalculateImmediate = function (skipCrossCheck) {
    // Task 2B.2 — never construct or send a pricing request for a block that can't
    // safely resolve which variant the customer is on (multi-variant + no section, or
    // inconsistent metadata). This is also the guard on "pricing request construction"
    // — `buildRequestBody()` is only ever reached past this point.
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }

    // Hidden-input cross-check (Task 2B, requirement D; unified in Task 2B.1,
    // requirement 1): read the page's own canonical variant field, if one was reliably
    // located, immediately before building this request. If it finds and acts on a
    // real mismatch, `crossCheckFormInput` has ALREADY taken over recalculation itself
    // (via the same `resolveAndAdoptVariant` the event path uses) — this call must not
    // also go on to send its own, now-superseded request against the old SKU/variant.
    if (!skipCrossCheck && this.crossCheckFormInput()) {
      return;
    }

    // Task 4A.5 — the loaded catalog must belong to the ACTIVE variant's SKU. After a
    // variant adoption whose catalog refetch failed (`showUnavailable` ran, `catalogSku`
    // never advanced), a later recalculation must NOT price the new variant against the
    // previous variant's still-loaded catalog — fail closed exactly as the failed fetch
    // itself did.
    if (this.catalog && this.catalogSku !== this.selectedVariantSku) {
      this.invalidateSignedQuote();
      this.showUnavailable();
      return;
    }

    var quantity = this.readQuantity();
    this.els.quantityError.hidden = true;
    this.els.quantity.setAttribute("aria-invalid", "false");

    // Every recalculation invalidates whatever cart pricing payload was showing
    // before — a stale (even if still technically validly-signed) payload must never
    // be submitted for a configuration the customer has since changed away from.
    this.invalidateSignedQuote();

    if (!quantity.valid) {
      this.els.quantityError.textContent = t(this.root, MESSAGES.invalidQuantity);
      this.els.quantityError.hidden = false;
      this.els.quantity.setAttribute("aria-invalid", "true");
      return;
    }

    var self = this;
    var seq = ++this.requestSeq;
    // Captured now, not re-derived from the DOM when the response arrives (Task 2B,
    // requirement E; Task 4A adds the product id; Task 5B.3A adds quantity + the config
    // generation) — this is what makes the eventual quote's ownership unambiguous.
    var requestProductId = this.shopifyProductId;
    var requestVariantId = this.selectedVariantId;
    var requestVariantSku = this.selectedVariantSku;
    var requestQuantity = quantity.value;
    var requestSelectionSeq = this.variantSelectionSequence;
    var requestConfigSeq = this.configSeq;

    if (this.activeController) this.activeController.abort();
    var controller = new AbortController();
    this.activeController = controller;

    this.showLoading(false);
    this.clearError();

    fetch(this.proxyPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(this.buildRequestBody()),
      signal: controller.signal,
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { status: response.status, body: body };
        });
      })
      .then(function (result) {
        // Ignore this response if a newer recalculation OR a newer variant selection
        // has already superseded it — either one means "what we asked about is no
        // longer what's on screen," so displaying this result would show a price for
        // the wrong thing (see class-level state doc comment above).
        if (seq !== self.requestSeq) return;
        if (requestSelectionSeq !== self.variantSelectionSequence) return;
        // Task 5B.3A — a quantity / configuration change since this request was sent
        // supersedes it exactly like a newer recalculation or variant selection: the
        // signed quote it would carry no longer owns what's on screen.
        if (requestConfigSeq !== self.configSeq) return;
        self.hideLoading();
        if (result.body && result.body.ok === true) {
          // Task 5B.3A.1 — apply the authoritative enforcement state from EVERY
          // successful response, even one that then fails the identity check below.
          if (result.body.data && result.body.data.enforcement) {
            self.updateEnforcementState(result.body.data.enforcement.state);
          }
          // Task 4A.1 §3: a successful product-context response MUST carry a valid,
          // matching `identity` (present, well-shaped, supported resolutionSource,
          // equal to this request AND the current selection, `product_override` for a
          // blank selected SKU). Anything else fails closed — clears the quote,
          // disables Add to Cart, shows a safe error, renders nothing.
          if (!self.responseIdentityOk(result.body.data && result.body.data.identity, requestProductId, requestVariantId)) {
            self.renderIdentityFailure();
            return;
          }
          self.renderResult(result.body.data, requestProductId, requestVariantId, requestVariantSku, requestQuantity);
        } else {
          self.renderError(result.body && result.body.error);
        }
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return;
        if (seq !== self.requestSeq) return;
        self.hideLoading();
        var local = self.computeLocalQuote(requestQuantity);
        if (local) {
          self.renderResult(local, requestProductId, requestVariantId, requestVariantSku, requestQuantity);
          return;
        }
        self.renderError(null);
      });
  };

  PricingBlock.prototype.clearError = function () {
    this.els.error.hidden = true;
    this.els.error.textContent = "";
  };

  PricingBlock.prototype.renderError = function (error) {
    var code = error && error.code;
    var key = MESSAGES.configurationError;
    if (!error) {
      key = MESSAGES.networkError;
    } else if (UNSUPPORTED_ERROR_CODES.indexOf(code) !== -1) {
      key = MESSAGES.unsupported;
    } else if (QUANTITY_ERROR_CODES.indexOf(code) !== -1) {
      key = MESSAGES.invalidQuantity;
    }
    this.els.error.textContent = t(this.root, key);
    this.els.error.hidden = false;
  };

  // Enables/disables Add to Cart based on whether the server actually returned a
  // signed cart pricing payload for the current configuration — never based on the
  // preview numbers alone, since a display price and a genuinely add-to-cart-able
  // price are two different guarantees (see storefront-handler.ts: no variant id, or
  // no server signing secret configured, both legitimately produce `cartPricing: null`
  // without that being a pricing error).
  PricingBlock.prototype.setCartPricing = function (cartPricing) {
    this.cartPricing = cartPricing || null;
    if (!this.els.addToCart) return;
    this.els.addToCart.disabled = !this.cartPricing;
    this.els.addToCart.removeAttribute("data-state");
    this.els.addToCartStatus.textContent = this.cartPricing
      ? ""
      : t(this.root, MESSAGES.addToCartUnavailable);
  };

  /** Task 5B.3A — drop the held signed quote and ALL its ownership immediately (product,
   * variant, SKU, quantity). Called synchronously the instant the customer changes a
   * variant, quantity, or configuration control, and on every aborted/failed request —
   * so a stale quote can never be submitted between the change and the next fresh quote
   * landing. */
  PricingBlock.prototype.invalidateSignedQuote = function () {
    this.setCartPricing(null);
    this.quotedProductId = null;
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
    this.quotedQuantity = null;
  };

  /**
   * Task 5B.3A — is `cartPricing` a COMPLETE v2 signed quote that OWNS the given
   * request's product / variant / quantity and has not expired? Returns `true` only
   * when every expected v2 attribute + payload field is present and well-typed and the
   * binding matches. A v1 envelope, an incomplete payload, a wrong-variant / wrong-
   * quantity binding, or an elapsed lifetime all return `false` (fail closed).
   */
  PricingBlock.prototype.v2QuoteOwns = function (cartPricing, productId, variantId, quantity) {
    var check = readSignedV2Quote(cartPricing);
    if (!check.ok) return false;
    if (parseProductVariantGid(check.payload.variantGid) !== variantId) return false;
    if (parseProductGid(check.payload.productGid) !== productId) return false;
    if (check.payload.quantity !== quantity) return false;
    if (isSignedV2QuoteExpired(check.payload, this._now())) return false;
    return true;
  };

  PricingBlock.prototype.renderResult = function (data, requestProductId, requestVariantId, requestVariantSku, requestQuantity) {
    // Task 2B.2 — never render a successful, addable quote for a block that can't
    // safely resolve the selected variant. (A gated `_recalculateImmediate` means this
    // is normally unreachable in that state; kept as the requirement-5 guard on the
    // "rendering a successful quote" step.)
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }

    // Task 4A.1 §3 — final canonical-identity check before showing anything
    // (belt-and-suspenders with `_recalculateImmediate`'s response handler): a
    // product-context quote must carry a valid `identity` matching this request AND the
    // current selection. Fail closed otherwise.
    if (!this.responseIdentityOk(data.identity, requestProductId, requestVariantId)) {
      this.renderIdentityFailure();
      return;
    }

    this.els.listUnit.textContent = formatMoney(data.base.listUnitPriceCents) + " / unit";
    this.els.netUnit.textContent = formatMoney(data.base.netUnitPriceCents) + " / unit";
    this.els.total.textContent = formatMoney(data.totals.netTotalCents);

    // Task 5B.3A — the display prices above always render, but Add to Cart only becomes
    // available on a CART-READY quote for THIS request:
    //   - envelope v2 (production): a complete, unexpired v2 payload whose bound
    //     product / variant / quantity match what was actually requested;
    //   - envelope v1 (non-production transition only): a structurally complete v1
    //     envelope (its payload carries no identity fields, so ownership is enforced by
    //     the request-time `quoted*` capture + the Add to Cart cross-checks).
    // Anything else → `cartPricing` stays null and Add to Cart stays disabled.
    var quoteReady = false;
    if (data.cartPricing && Number(data.cartPricing.version) === 2) {
      quoteReady = this.v2QuoteOwns(data.cartPricing, requestProductId, requestVariantId, requestQuantity);
    } else if (data.cartPricing) {
      quoteReady = !!legacyV1QuoteAttributes(data.cartPricing);
    }

    this.setCartPricing(quoteReady ? data.cartPricing : null);

    // Quote ownership (Task 2B, requirement E; Task 4A adds the product id; Task 5B.3A
    // adds the quantity): recorded ONLY from the values this specific request was
    // actually sent with, never by re-reading current state now (which may have moved
    // on by the time this response arrives).
    if (quoteReady) {
      this.quotedProductId = requestProductId;
      this.quotedVariantId = requestVariantId;
      this.quotedVariantSku = requestVariantSku;
      this.quotedQuantity = requestQuantity;
    } else {
      this.quotedProductId = null;
      this.quotedVariantId = null;
      this.quotedVariantSku = null;
      this.quotedQuantity = null;
    }

    this.els.tierNote.textContent = t(this.root, "dynamic_pricing.tier_note", "Pricing shown for {min}+ units.").replace(
      "{min}",
      String(data.quantityTier.minQuantity),
    );

    this.renderTierTable(data.availableQuantityTiers, data.quantityTier);
    this.renderBreakdown(data);
  };

  PricingBlock.prototype.renderTierTable = function (tiers, selectedTier) {
    if (!tiers || !tiers.length) {
      this.els.tierTable.hidden = true;
      return;
    }
    this.els.tierTableBody.innerHTML = "";
    tiers.forEach(function (tier) {
      var row = document.createElement("tr");
      if (selectedTier && tier.id === selectedTier.id) {
        row.setAttribute("aria-current", "true");
      }
      var qtyCell = document.createElement("th");
      qtyCell.setAttribute("scope", "row");
      qtyCell.textContent = tier.minQuantity + "+";
      var listCell = document.createElement("td");
      listCell.textContent = formatMoney(tier.listUnitPriceCents);
      var netCell = document.createElement("td");
      netCell.textContent = formatMoney(tier.netUnitPriceCents);
      row.appendChild(qtyCell);
      row.appendChild(listCell);
      row.appendChild(netCell);
      this.els.tierTableBody.appendChild(row);
    }, this);
    this.els.tierTable.hidden = false;
  };

  PricingBlock.prototype.renderBreakdown = function (data) {
    var list = this.els.breakdownList;
    var root = this.root;
    list.innerHTML = "";

    var addRow = function (labelKey, fallback, cents) {
      var dt = document.createElement("dt");
      dt.textContent = t(root, labelKey, fallback);
      var dd = document.createElement("dd");
      dd.textContent = formatMoney(cents);
      list.appendChild(dt);
      list.appendChild(dd);
    };

    addRow("dynamic_pricing.breakdown_base", "Base Product", data.base.netSubtotalCents);
    if (data.productColor && data.productColor.priceAdjustmentCents) {
      addRow("dynamic_pricing.breakdown_color", "Product Color", data.productColor.priceAdjustmentCents);
    }
    if (data.decoration) {
      addRow("dynamic_pricing.breakdown_decoration", "Decoration", data.decoration.netChargesCents);
    }
    if (data.options && data.options.selections.length) {
      addRow("dynamic_pricing.breakdown_options", "Options", data.options.chargesCents);
    }
    if (data.production) {
      addRow("dynamic_pricing.breakdown_production", "Production", data.production.feeCents || 0);
    }
    addRow("dynamic_pricing.breakdown_total_list", "List Total", data.totals.listTotalCents);
    addRow("dynamic_pricing.breakdown_total", "Total", data.totals.netTotalCents);

    if (this.root.dataset.showBreakdown === "true") {
      this.els.breakdown.setAttribute("open", "open");
    }
  };

  // --- Variant synchronization (Task 2B) ------------------------------------------

  /**
   * Resolves this block's owning Shopify section container via `data-section-id` (set
   * from `{{ section.id }}` in the block's Liquid) — the single, shared way both
   * `bindVariantSelectListener` and `resolveFormVariantInput` locate "this block's own
   * section" (Task 2B.1, requirement 2 — previously each duplicated this lookup
   * separately, with the listener additionally falling back to a bare ancestor-walk
   * `root.closest(...)` that `resolveFormVariantInput` didn't share). Returns `null`
   * (never guesses, never walks up to an unrelated ancestor, never falls back to the
   * whole document) if `data-section-id` is missing or no matching container exists —
   * callers must fail closed for whatever they needed the section for.
   */
  PricingBlock.prototype.resolveSectionContainer = function () {
    var sectionId = this.root.dataset.sectionId;
    if (!sectionId) return null;
    var doc = this.root.ownerDocument;

    // The real Shopify section wrapper is the authoritative unit — it is the element
    // Shopify's Theme Editor and Horizon's own section rendering replace, and the one
    // `shopify:section:load` / `:unload` fire against.
    var wrapper = doc.getElementById("shopify-section-" + sectionId);
    if (wrapper) return wrapper;

    // Fallback for themes that mark the section with `data-section-id` instead: accept
    // ONLY a real ancestor container of this block's root — NEVER the block's own root
    // (the Liquid emits `data-section-id` on the root too, so a naive
    // `querySelector('[data-section-id=…]')` would match the root itself and scope every
    // "within the section" lookup to the block, finding no product form or picker).
    var self = this;
    var marked = doc.querySelectorAll('[data-section-id="' + sectionId + '"]');
    var container = null;
    for (var i = 0; i < marked.length; i++) {
      var el = marked[i];
      if (el === self.root || !el.contains(self.root)) continue;
      if (!container || container.contains(el)) container = el; // keep the innermost real ancestor
    }
    return container;
  };

  /**
   * Locates the canonical `input[name="id"]` for this product's purchase form — a
   * fallback/cross-check only (see `crossCheckFormInput`), never the primary
   * notification mechanism (that's `shopify:product:select`, below). Deliberately does
   * NOT use `root.closest("product-form")` alone: Horizon's app blocks can render as
   * *siblings* of the product form within the same section, not descendants of it, so
   * `closest` would silently find nothing on exactly the layout this app targets.
   * Scoped entirely to `resolveSectionContainer()`'s result — searches *within* that
   * section only, for the narrowest reliable match, so a hidden `input[name="id"]`
   * belonging to a *different* product form elsewhere on the page is never picked up
   * by mistake. Returns `null` if no section container or field can be found —
   * callers must treat that as "no reliable cross-check available," continuing on the
   * validated event/initial state alone, never falling back to an unrelated form.
   */
  PricingBlock.prototype.resolveFormVariantInput = function () {
    var resolved = this.resolveOwnedProductFormInput();
    this.variantOwnershipAmbiguous = resolved.ambiguous;
    return resolved.input;
  };

  /**
   * Task 4A.5 (strict ownership) — resolves the ONE authoritative `input[name="id"]`
   * for this block's own product form, scoped entirely to `resolveSectionContainer()`:
   *
   *   - never an `input[name="id"]` that isn't actually inside a `<product-form>`/`<form>`;
   *   - never one inside a quick-add tile, a recommendation/product card, or a
   *     complementary-product block (`isExcludedFormContext`) — those belong to a
   *     different purchasable unit;
   *   - when the section legitimately holds several candidates for the SAME product
   *     (main form + sticky buy-buttons), the canonical `<product-form>` is chosen
   *     (`formInputRank`);
   *   - when two rival top-rank candidates disagree on their current value (genuinely
   *     ambiguous which product form the customer is on), returns
   *     `{ input: null, ambiguous: true }` so callers fail closed via
   *     `variant_sync_error` rather than guess.
   *
   * `{ input: null, ambiguous: false }` — no reliable field at all — is NOT a failure:
   * callers continue on the validated event/initial state, exactly as before Task 4A.5.
   */
  PricingBlock.prototype.resolveOwnedProductFormInput = function () {
    var container = this.resolveSectionContainer();
    if (!container) return { input: null, ambiguous: false };

    var all = container.querySelectorAll('input[name="id"]');
    var candidates = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.closest || !el.closest("product-form, form")) continue;
      if (isExcludedFormContext(el)) continue;
      candidates.push(el);
    }
    if (candidates.length === 0) return { input: null, ambiguous: false };

    candidates.sort(function (a, b) {
      return formInputRank(a) - formInputRank(b);
    });
    var best = candidates[0];
    var bestRank = formInputRank(best);
    var peers = candidates.filter(function (c) {
      return formInputRank(c) === bestRank;
    });
    if (peers.length > 1) {
      var v = best.value;
      var allAgree = peers.every(function (c) {
        return c.value === v;
      });
      if (!allAgree) return { input: null, ambiguous: true };
    }
    return { input: best, ambiguous: false };
  };

  /**
   * Task 4A.5 (strict ownership) — the Horizon `<variant-picker>` (or legacy
   * `<variant-selects>`) that belongs to THIS block's section and product. `null` when
   * none exists (a single-option product, or a non-Horizon theme). When more than one
   * exists and none can be tied to `this.shopifyProductId` via `data-product-id`,
   * returns `{ picker: null, ambiguous: true }` — callers fail closed.
   */
  PricingBlock.prototype.resolveOwnedVariantPicker = function () {
    var container = this.resolveSectionContainer();
    if (!container) return { picker: null, ambiguous: false };

    var found = container.querySelectorAll("variant-picker, variant-selects");
    var candidates = [];
    for (var i = 0; i < found.length; i++) {
      if (!isExcludedFormContext(found[i])) candidates.push(found[i]);
    }
    if (candidates.length === 0) return { picker: null, ambiguous: false };
    if (candidates.length === 1) return { picker: candidates[0], ambiguous: false };

    var wanted = this.shopifyProductId || "";
    if (wanted) {
      var matched = candidates.filter(function (p) {
        var pid = p.getAttribute("data-product-id") || "";
        return pid && String(parseShopifyNumericId(pid) || "") === String(wanted);
      });
      if (matched.length === 1) return { picker: matched[0], ambiguous: false };
    }
    return { picker: null, ambiguous: true };
  };

  // Bubbled non-standard variant-change event names some themes/apps emit on the
  // section. Reacting to any only schedules a reconcile against the authoritative hidden
  // input — an event-supplied variant object is never trusted — so a broad list is safe
  // and depends on no single theme-specific name.
  var BUBBLED_VARIANT_EVENTS = [
    "variant:change",
    "variant:update",
    "on:variant:update",
    "product:variant-change",
    "variantchange",
    "shopify:variant:change",
  ];

  /**
   * Task 4A.5 / 4A.5.1 — everything that has to track this block's owning Shopify
   * section: Horizon variant synchronization, native cart containment, and
   * section-replacement lifecycle. Split into two layers:
   *
   *   - master (bound exactly once, on `lifecycleController`): the bubbled variant
   *     events on the section, the in-section `MutationObserver`, the
   *     section-node-replacement observer on the section's parent, and the
   *     `shopify:section:load` / `:unload` lifecycle listeners;
   *   - rebindable (`_sectionBindingController`, torn down and recreated whenever
   *     Horizon swaps the owning form / picker / native buttons in place): the
   *     `change` / `input` listeners on the owning picker + form, and the native
   *     containment click / submit guards.
   */
  PricingBlock.prototype.bindSectionScope = function () {
    var container = this.resolveSectionContainer();
    if (!container) return; // no section — `canUseDynamicPricing` already gates multi-variant here

    var self = this;
    var view = this.root.ownerDocument.defaultView || window;
    var doc = this.root.ownerDocument;

    if (!this._sectionScopeMasterBound) {
      this._sectionScopeMasterBound = true;
      var master = this.lifecycleController.signal;
      var schedule = this.scheduleOwnedVariantReconcile.bind(this);

      for (var b = 0; b < BUBBLED_VARIANT_EVENTS.length; b++) {
        container.addEventListener(BUBBLED_VARIANT_EVENTS[b], schedule, { signal: master });
      }

      if (typeof view.MutationObserver === "function") {
        // In-section: hidden-input `value` attribute changes, hidden-input / product-form
        // / native-button replacement, and section inner-HTML re-render.
        this.horizonVariantObserver = new view.MutationObserver(function () {
          self.scheduleSectionMaintenance();
        });
        this.horizonVariantObserver.observe(container, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["value"],
        });

        // A `MutationObserver` on an element cannot see that element itself being
        // removed / replaced — so observe the section's PARENT, filtered to childList
        // only, purely to notice the section node leaving the DOM. Never the whole
        // document.
        var parent = container.parentNode;
        if (parent && parent.nodeType === 1) {
          this.sectionReplacementObserver = new view.MutationObserver(function () {
            self.handleSectionNodeReplacement();
          });
          this.sectionReplacementObserver.observe(parent, { childList: true });
        }
      }

      // Theme Editor section lifecycle — strictly filtered to THIS section id, cleaned
      // up with the master signal.
      var onLifecycle = this.handleSectionLifecycleEvent.bind(this);
      doc.addEventListener("shopify:section:load", onLifecycle, { signal: master });
      doc.addEventListener("shopify:section:unload", onLifecycle, { signal: master });
    }

    this.bindRebindableSectionListeners();
  };

  /**
   * Task 4A.5.1 — (re)bind the listeners that are attached to specific owning-section
   * NODES (the picker, the product form, the native buttons), so a Horizon in-place
   * swap of any of them can't leave this block listening to a detached element. Aborts
   * the previous binding generation first, so nothing ever stacks.
   */
  PricingBlock.prototype.bindRebindableSectionListeners = function () {
    if (this.destroyed) return;
    var container = this.resolveSectionContainer();
    if (!container) return;

    if (this._sectionBindingController) this._sectionBindingController.abort();
    this._sectionBindingController = new AbortController();
    var signal = this._sectionBindingController.signal;

    var formInfo = this.resolveOwnedProductFormInput();
    var pickerInfo = this.resolveOwnedVariantPicker();

    // Native containment first — it must hold in EVERY state, including the ambiguous /
    // fail-closed one below (an unsigned native add is exactly what must not slip
    // through when we cannot safely sync).
    this.applyNativeCartContainment(signal);

    if (formInfo.ambiguous || pickerInfo.ambiguous) {
      if (!this.variantSyncUnavailable) this.failClosedForSync();
      this._boundOwnerForm = null;
      this._boundOwnerPicker = null;
      return;
    }

    this.formVariantInput = formInfo.input;
    this.variantOwnershipAmbiguous = false;
    this._boundOwnerForm = formInfo.input ? formInfo.input.closest("product-form, form") : null;
    this._boundOwnerPicker = pickerInfo.picker || null;

    var schedule = this.scheduleOwnedVariantReconcile.bind(this);
    var targets = [];
    if (this._boundOwnerPicker) targets.push(this._boundOwnerPicker);
    var realForm = formInfo.input ? formInfo.input.closest("form") : null;
    if (realForm && targets.indexOf(realForm) === -1) targets.push(realForm);
    for (var i = 0; i < targets.length; i++) {
      targets[i].addEventListener("change", schedule, { signal: signal });
      targets[i].addEventListener("input", schedule, { signal: signal });
    }
  };

  /**
   * Task 4A.5.2 / 5B.3A.1 — whether this block must CONTAIN the native Shopify cart.
   *
   * `true` when enforcement is intended (a valid Shopify product id) AND the
   * authoritative enforcement decision is NOT an explicit `bypass`. It is DELIBERATELY
   * INDEPENDENT of variant-metadata validity: a block whose `data-variant-map` is
   * missing / blank / malformed / empty / inconsistent, or whose section
   * synchronization has failed, or that hit a pricing/catalog error, still holds native
   * containment (fail closed) — UNLESS the server has told it, via
   * `data.enforcement.state === "bypass"`, that enforcement is explicitly, safely OFF
   * for this product (a `disabled` shop policy, or a pilot-unmarked product).
   */
  PricingBlock.prototype.nativeContainmentRequired = function () {
    return this.pricingEnforcementIntended === true && this._enforcementState !== "bypass";
  };

  /**
   * Task 5B.3A.1 — apply an authoritative server enforcement state. `"bypass"` releases
   * native containment (an explicit safe-native-bypass); `"enforce"` / `"block"` /
   * anything unrecognised keeps (or re-asserts) containment — fail closed.
   */
  PricingBlock.prototype.updateEnforcementState = function (state) {
    if (this.destroyed) return;
    var next = state === "enforce" || state === "bypass" || state === "block" ? state : "block";
    if (next === this._enforcementState && next !== "bypass") {
      // no change, and not a bypass we might still need to (re-)release for — nothing to do
      return;
    }
    this._enforcementState = next;
    if (next === "bypass") {
      this.releaseNativeCartContainment();
    } else {
      // block / enforce → make sure the native cart is (still) contained, e.g. after a
      // shop toggled back from `disabled` to `pilot`.
      this.applyNativeCartContainment();
    }
  };

  /**
   * Task 5B.3A.1 / 5B.3B — undo native containment for an authoritative `bypass`:
   * restore each contained control's EXACT original accessibility state (original
   * `disabled`; `aria-disabled` restored to its exact prior value, or removed entirely
   * if it never existed), drop the bookkeeping markers, and remove the capture-phase
   * click / submit guards. Never re-enables a control Shopify / the theme originally
   * disabled, and never leaves a stray `aria-disabled` the theme did not author.
   */
  PricingBlock.prototype.releaseNativeCartContainment = function () {
    if (this.destroyed) return;
    var container = this.resolveSectionContainer();
    if (!container) return;
    var self = this;

    var controls = container.querySelectorAll('[data-imprintid-contained="1"]');
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      if (!self.inThisSection(el)) continue;
      try {
        if ("disabled" in el) el.disabled = el.getAttribute("data-imprintid-was-disabled") === "1";
      } catch (e) {
        /* no `disabled` IDL attribute */
      }
      if (el.getAttribute("data-imprintid-had-aria-disabled") === "1") {
        el.setAttribute("aria-disabled", el.getAttribute("data-imprintid-orig-aria-disabled") || "");
      } else {
        el.removeAttribute("aria-disabled");
      }
      el.removeAttribute("data-imprintid-was-disabled");
      el.removeAttribute("data-imprintid-had-aria-disabled");
      el.removeAttribute("data-imprintid-orig-aria-disabled");
      el.removeAttribute("data-imprintid-contained");
      el.removeEventListener("click", this._nativeControlClickGuard, true);
    }

    var forms = container.querySelectorAll('[data-imprintid-contained-form="1"]');
    for (var f = 0; f < forms.length; f++) {
      if (!self.inThisSection(forms[f])) continue;
      forms[f].removeAttribute("data-imprintid-contained-form");
      forms[f].removeEventListener("submit", this._nativeFormSubmitGuard, true);
    }

    this.root.setAttribute("data-imprintid-native-contained", "false");
  };

  /**
   * Task 4A.5.1 — disable + block every native purchase control in the owning section
   * (main Add-to-Cart, sticky Add-to-Cart, `button[type=submit]`, `input[type=submit]`,
   * `name="add"` controls, and `[form="<owning-form-id>"]` controls that live in the
   * SAME section), and neutralise the owning form's own `submit` (covering
   * `form.requestSubmit()` and Horizon's / a theme's submit handler). Idempotent: a
   * control already carrying the containment marker is only re-checked, never re-set, so
   * a re-run produces no mutation and cannot feed the section `MutationObserver` into a
   * loop. Does NOT patch `HTMLFormElement.prototype`; does NOT touch the ImprintID
   * button, quick-add / recommendation / complementary forms, or another section.
   */
  PricingBlock.prototype.applyNativeCartContainment = function (signal) {
    if (this.destroyed) return;
    var sig = signal || (this._sectionBindingController && this._sectionBindingController.signal) || this.lifecycleController.signal;
    var container = this.resolveSectionContainer();
    if (!container || !this.nativeContainmentRequired()) return;
    var self = this;

    // Owning-section product forms (never our own block, never an excluded context).
    var ownerForms = [];
    var formNodes = container.querySelectorAll(
      'product-form form,form[action*="/cart/add"],form[data-type="add-to-cart-form"]',
    );
    for (var f = 0; f < formNodes.length; f++) {
      var fm = formNodes[f];
      if (self.root.contains(fm) || isExcludedFormContext(fm) || !self.inThisSection(fm)) continue;
      ownerForms.push(fm);
    }

    var controls = [];
    var addControl = function (el) {
      if (!el || self.root.contains(el) || isExcludedFormContext(el) || !self.inThisSection(el)) return;
      if (controls.indexOf(el) === -1) controls.push(el);
    };

    // 1–3: submit controls inside each owning form, plus `name="add"` controls anywhere
    // in the section, plus `[form="<id>"]` controls that reference an owning form.
    for (var of2 = 0; of2 < ownerForms.length; of2++) {
      var list = ownerForms[of2].querySelectorAll(NATIVE_SUBMIT_SELECTOR);
      for (var c = 0; c < list.length; c++) addControl(list[c]);
      var fid = ownerForms[of2].id;
      if (fid) {
        var linked = container.querySelectorAll('[form="' + cssEscapeIdent(fid) + '"]');
        for (var l = 0; l < linked.length; l++) {
          var lc = linked[l];
          if (lc.tagName === "BUTTON" || lc.type === "submit" || lc.getAttribute("name") === "add") addControl(lc);
        }
      }
    }
    var addNamed = container.querySelectorAll('button[name="add"],input[name="add"]');
    for (var an = 0; an < addNamed.length; an++) addControl(addNamed[an]);

    // 4: sticky / floating add-to-cart bars in this section.
    var stickies = container.querySelectorAll(STICKY_WRAPPER_SELECTOR);
    for (var s = 0; s < stickies.length; s++) {
      if (isExcludedFormContext(stickies[s]) || !self.inThisSection(stickies[s])) continue;
      var sc = stickies[s].querySelectorAll(NATIVE_SUBMIT_SELECTOR);
      for (var sci = 0; sci < sc.length; sci++) addControl(sc[sci]);
    }

    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      if (el.getAttribute("data-imprintid-contained") !== "1") {
        // Task 5B.3B — record the control's EXACT original accessibility state so an
        // authoritative `bypass` can restore it byte-for-byte and never re-enable /
        // re-label something the theme itself had disabled (e.g. an out-of-stock
        // variant): (1) original `disabled`; (2) whether `aria-disabled` existed at all;
        // (3) its exact original value when it did.
        try {
          el.setAttribute("data-imprintid-was-disabled", "disabled" in el && el.disabled ? "1" : "0");
        } catch (e) {
          el.setAttribute("data-imprintid-was-disabled", "0");
        }
        if (el.hasAttribute("aria-disabled")) {
          el.setAttribute("data-imprintid-had-aria-disabled", "1");
          el.setAttribute("data-imprintid-orig-aria-disabled", el.getAttribute("aria-disabled") || "");
        } else {
          el.setAttribute("data-imprintid-had-aria-disabled", "0");
        }
        try {
          if ("disabled" in el) el.disabled = true;
        } catch (e2) {
          /* control type without a `disabled` IDL attribute — aria + click guard cover it */
        }
        el.setAttribute("data-imprintid-contained", "1");
        el.setAttribute("aria-disabled", "true");
      }
      // `addEventListener` de-dupes by (type, listener, capture); a re-run with a fresh
      // signal after an abort re-arms cleanly, a re-run without one is a no-op.
      el.addEventListener("click", this._nativeControlClickGuard, { capture: true, signal: sig });
    }

    for (var w = 0; w < ownerForms.length; w++) {
      ownerForms[w].setAttribute("data-imprintid-contained-form", "1");
      ownerForms[w].addEventListener("submit", this._nativeFormSubmitGuard, { capture: true, signal: sig });
    }

    this.root.setAttribute("data-imprintid-native-contained", controls.length || ownerForms.length ? "true" : "false");
  };

  /**
   * True when `el` is inside THIS block's exact owning section — never a nested inner
   * section and never a sibling section (e.g. a product-recommendations section). Walks
   * up to the nearest section marker (`#shopify-section-*` or `[data-section-id]`,
   * ignoring the block's own root, which also carries `data-section-id`) and compares
   * ids; a marker for a DIFFERENT section short-circuits to `false`.
   */
  PricingBlock.prototype.inThisSection = function (el) {
    if (!this._sectionId) return true;
    var mine = "shopify-section-" + this._sectionId;
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.id === mine) return true;
      var marked = node.getAttribute ? node.getAttribute("data-section-id") : null;
      if (marked && node !== this.root) return marked === this._sectionId;
      if (node.id && node.id.indexOf("shopify-section-") === 0) return node.id === mine;
      node = node.parentNode;
    }
    return true;
  };

  PricingBlock.prototype.handleContainedControlClick = function (event) {
    var el = event.currentTarget;
    if (el && el.getAttribute && el.getAttribute("data-imprintid-contained") === "1") {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      event.stopPropagation();
    }
  };

  PricingBlock.prototype.handleContainedFormSubmit = function (event) {
    var form = event.currentTarget;
    if (form && form.getAttribute && form.getAttribute("data-imprintid-contained-form") === "1") {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      event.stopPropagation();
    }
  };

  /**
   * Task 4A.5.1 — coalesce a burst of in-section mutations (Horizon's section re-render
   * fires many) into ONE maintenance pass on the next microtask.
   */
  PricingBlock.prototype.scheduleSectionMaintenance = function () {
    if (this.destroyed || this._sectionMaintenanceScheduled) return;
    this._sectionMaintenanceScheduled = true;
    var self = this;
    var view = this.root.ownerDocument.defaultView || window;
    var run = function () {
      self._sectionMaintenanceScheduled = false;
      self.runSectionMaintenance();
    };
    if (typeof view.queueMicrotask === "function") view.queueMicrotask(run);
    else view.setTimeout(run, 0);
  };

  /**
   * Task 4A.5.1 — the in-section `MutationObserver` fired. If this block's root is gone,
   * defer to `handleSectionNodeReplacement`. Otherwise: if Horizon swapped the owning
   * form / picker node in place, rebind the node-scoped listeners; always re-assert
   * native containment (a replaced main / sticky button is contained immediately); and
   * reconcile the currently selected variant.
   */
  PricingBlock.prototype.runSectionMaintenance = function () {
    if (this.destroyed) return;
    if (!this.root.isConnected) {
      this.handleSectionNodeReplacement();
      return;
    }
    var formInfo = this.resolveOwnedProductFormInput();
    var pickerInfo = this.resolveOwnedVariantPicker();
    var newForm = formInfo.input ? formInfo.input.closest("product-form, form") : null;
    var newPicker = pickerInfo.picker || null;
    if (newForm !== this._boundOwnerForm || newPicker !== this._boundOwnerPicker) {
      this.bindRebindableSectionListeners();
    } else {
      this.applyNativeCartContainment();
    }
    this.reconcileOwnedVariant();
  };

  /**
   * Task 4A.5.1 — the owning section node itself was removed or replaced (its parent's
   * child list changed and our root / section is no longer resolvable). Tear this
   * instance down completely and reconstruct a fresh block for the replacement section's
   * root, exactly once.
   */
  PricingBlock.prototype.handleSectionNodeReplacement = function () {
    if (this.destroyed) return;
    if (this.root.isConnected && this.resolveSectionContainer()) return; // false alarm
    var doc = this.root.ownerDocument;
    var id = this._sectionId;
    this.destroy();
    if (!id) return;
    var scope =
      doc.getElementById("shopify-section-" + id) ||
      (function () {
        var marked = doc.querySelectorAll('[data-section-id="' + id + '"]');
        for (var i = 0; i < marked.length; i++) if (marked[i].querySelector && marked[i].querySelector("[data-imprintid-pricing]")) return marked[i];
        return null;
      })();
    if (!scope) return;
    var fresh = scope.querySelector("[data-imprintid-pricing]");
    if (fresh && !fresh.imprintIdPricingBlock) {
      if (!fresh.id) fresh.id = "imprintid-pricing-reinit-" + id;
      fresh.imprintIdPricingBlock = new PricingBlock(fresh);
    }
  };

  /**
   * Task 4A.5.1 — a `shopify:section:load` / `:unload` for THIS section id (Theme
   * Editor). If our root survived (in-place inner re-render kept it), rebind node-scoped
   * listeners + containment and reconcile. If it's gone, hand off to
   * `handleSectionNodeReplacement`. Repeated events are naturally idempotent — a
   * same-variant reconcile issues no request, and rebinding aborts the prior generation.
   */
  PricingBlock.prototype.handleSectionLifecycleEvent = function (event) {
    if (this.destroyed) return;
    var detail = event && event.detail;
    if (!detail || String(detail.sectionId) !== String(this._sectionId)) return;
    if (!this.root.isConnected || !this.resolveSectionContainer()) {
      this.handleSectionNodeReplacement();
      return;
    }
    this.bindRebindableSectionListeners();
    this.scheduleOwnedVariantReconcile();
  };

  /**
   * Task 4A.5 (request deduplication). Horizon emits several signals for one selection
   * (a radio `change`, an `input`, then — once it has swapped in the re-rendered section
   * HTML / updated the hidden input — a mutation the observer sees). This coalesces the
   * whole burst into ONE `reconcileOwnedVariant` on the next microtask: every signal in
   * the same task collapses to a single reconcile, and each later signal (e.g. the
   * mutation that lands after Horizon finishes updating the hidden input) schedules
   * exactly one more. Not a recurring timer. `reconcileOwnedVariant` itself no-ops when
   * the hidden input already agrees with the current selection, so a redundant run from
   * this block's own re-render costs only a DOM read.
   */
  PricingBlock.prototype.scheduleOwnedVariantReconcile = function () {
    if (this.destroyed) return;
    if (this._ownedReconcileScheduled) return;
    this._ownedReconcileScheduled = true;
    var self = this;
    var view = this.root.ownerDocument.defaultView || window;
    var run = function () {
      self._ownedReconcileScheduled = false;
      self.reconcileOwnedVariant();
    };
    if (typeof view.queueMicrotask === "function") view.queueMicrotask(run);
    else view.setTimeout(run, 0);
  };

  /**
   * Task 4A.5 (variant adoption lifecycle). Re-resolves ownership (the form / hidden
   * input / section may have been replaced by Horizon), fails closed on ambiguity, then
   * reconciles against the authoritative hidden `input[name="id"]`. When it names a
   * different, syntactically valid id than the current selection, invalidates the
   * current request generation and hands the id to the ONE shared adoption path
   * (`resolveAndAdoptVariant`) — which validates it against `data-variant-map`, aborts
   * in-flight catalog/pricing requests, clears `cartPricing` + every quote-ownership
   * field (disabling Add to Cart), retains the immutable Shopify product id, and issues
   * exactly one fresh calculation whose response is accepted only if still current.
   * Selecting the already-active variant produces no request.
   */
  PricingBlock.prototype.reconcileOwnedVariant = function () {
    if (this.destroyed || !this.root.isConnected) return;
    if (!this.canUseDynamicPricing()) {
      // Idempotent: `failClosedForSync` mutates this section's DOM, which the observer
      // sees — calling it again on every resulting reconcile would spin. It has already
      // put the block in the fail-closed state.
      if (!this.variantSyncUnavailable) this.failClosedForSync();
      return;
    }

    var formInfo = this.resolveOwnedProductFormInput();
    var pickerInfo = this.resolveOwnedVariantPicker();
    if (formInfo.ambiguous || pickerInfo.ambiguous) {
      if (!this.variantSyncUnavailable) this.failClosedForSync();
      return;
    }
    this.formVariantInput = formInfo.input;
    this.variantOwnershipAmbiguous = false;

    if (!formInfo.input) return; // no authoritative field — event/initial state stands
    var raw = formInfo.input.value;
    if (!isPositiveDigitString(raw)) return; // Horizon hasn't settled a usable id yet

    // Idempotency guard: the shared adoption path renders into this section, which the
    // MutationObserver sees, which schedules another reconcile. On success `raw` now
    // equals `selectedVariantId` (next check); on failure (unmapped / unavailable id)
    // it does not — this stops that case from re-adopting the same bad id forever.
    if (raw === this._lastReconciledFormValue) return;
    this._lastReconciledFormValue = raw;

    if (raw === this.selectedVariantId) return; // already on this variant — no request

    // Adoption lifecycle: bump the variant-selection generation so any pricing response
    // captured against the prior selection is discarded on arrival (see
    // `_recalculateImmediate`'s stale guard), then run the shared adoption path.
    this.variantSelectionSequence++;
    this.resolveAndAdoptVariant(raw);
  };

  /**
   * Registers the `shopify:product:select` listener directly on this block's owning
   * Shopify section container (Task 2B.1, requirement 2) — NEVER a permanent
   * document-level listener. A section-scoped listener is naturally
   * garbage-collectable the instant Shopify's Theme Editor removes or replaces that
   * section's DOM (the listener dies along with the element it's attached to, exactly
   * like any other DOM-attached listener with no other live references); a
   * document-level listener never would, accumulating for the page's entire lifetime
   * across every section replacement — that permanent-listener leak is what this
   * revision removes.
   *
   * If the owning section can't be resolved, this block has no safe place to attach a
   * listener at all — rather than guessing (a bare document listener, or picking some
   * unrelated ancestor), it fails closed for dynamic variant synchronization
   * specifically: `variantSelectListenTarget` stays `null`, a non-secret diagnostic is
   * logged (names only that section resolution failed — never any product/variant/
   * secret data), and the block continues working from whatever variant Liquid
   * rendered initially, plus the hidden-input cross-check if a reliable field is
   * separately found (that lookup fails closed independently, the same way).
   */
  PricingBlock.prototype.bindVariantSelectListener = function () {
    var container = this.resolveSectionContainer();
    if (!container) {
      this.variantSelectListenTarget = null;
      console.warn(
        '[dynamic-pricing] Could not resolve this block\'s owning Shopify section (data-section-id="' +
          (this.root.dataset.sectionId || "") +
          '") — dynamic variant synchronization via ' +
          PRODUCT_SELECT_EVENT +
          " is unavailable for this block; it will keep using the variant selected at " +
          "page render instead. No product, variant, or secret data is included in this message.",
      );
      return;
    }

    this.variantSelectListenTarget = container;
    container.addEventListener(
      PRODUCT_SELECT_EVENT,
      this.handleProductSelect.bind(this),
      { signal: this.lifecycleController.signal },
    );
  };

  /**
   * Handles a `shopify:product:select` event (Task 2B, requirement C). Per the
   * confirmed real contract for this event: `event.product.id` is the product's GID,
   * `event.selectedOptions` describes the newly-chosen option values, and
   * `event.promise` resolves to `{ variant: {...} | null }` (or rejects) once Shopify
   * has resolved which real variant (if any) matches the new selection. This
   * deliberately reads none of those fields except exactly what the confirmed contract
   * specifies — no undocumented `event.detail.*` shape is assumed.
   */
  PricingBlock.prototype.handleProductSelect = function (event) {
    // Secondary defense-in-depth, not the primary cleanup mechanism (that's the
    // section-scoped listener target dying with its own DOM — see
    // `bindVariantSelectListener`'s doc comment): covers the narrower case where this
    // block's *section* persists but this block's own *root* is replaced within it
    // (a block-level, not section-level, Theme Editor re-render). If this instance was
    // explicitly destroyed, or its root is no longer attached to the document at all,
    // abort the underlying listener and do nothing further.
    if (this.destroyed || !this.root.isConnected) {
      this.lifecycleController.abort();
      return;
    }

    if (!this.productGid) return; // no trusted product GID to filter against — never guess
    var eventProductId = event && event.product && event.product.id;
    if (eventProductId !== this.productGid) return; // ignore events for a different product

    // Immediate invalidation (before we even know what the new variant is) — a quote
    // computed for the old selection must never remain addable once ANY change has
    // started, even if the new variant turns out to be unavailable or invalid.
    this.invalidateSignedQuote();
    if (this.activeController) this.activeController.abort();

    var seq = ++this.variantSelectionSequence;
    var selectSeq = ++this.productSelectSeq;

    var promise = event && event.promise;
    if (!promise || typeof promise.then !== "function") {
      this.handleVariantSyncFailure(seq, selectSeq);
      return;
    }

    var self = this;
    promise.then(
      function (resolution) {
        self.onVariantSelectResolved(seq, selectSeq, resolution);
      },
      function () {
        self.handleVariantSyncFailure(seq, selectSeq);
      },
    );
  };

  PricingBlock.prototype.onVariantSelectResolved = function (seq, selectSeq, resolution) {
    // A newer selection (or a newer promise for the same generation) has already
    // superseded this one — ignore, exactly like a stale fetch response.
    if (seq !== this.variantSelectionSequence || selectSeq !== this.productSelectSeq) return;

    var variant = resolution && resolution.variant;
    if (!variant) {
      this.handleVariantUnavailable();
      return;
    }

    var numericId = parseProductVariantGid(variant.id);
    if (!numericId) {
      this.handleVariantSyncFailure(seq, selectSeq);
      return;
    }

    // Event-specific corroboration, checked here (not inside the shared method below)
    // because only the event supplies it: `resolveAndAdoptVariant` independently checks
    // the trusted map's own `available` flag regardless, so the net effect is exactly
    // "both the event AND the map must agree the variant is available," unchanged from
    // before this method was unified with the hidden-input path.
    if (!variant.availableForSale) {
      this.handleVariantUnavailable();
      return;
    }

    this.resolveAndAdoptVariant(numericId);
  };

  /**
   * The one shared variant-adoption path (Task 2B.1, requirement 1). Both
   * `onVariantSelectResolved` (the `shopify:product:select` event path, after its own
   * event-specific checks above) and `crossCheckFormInput` (the hidden-input fallback,
   * after confirming the DOM value actually differs from `selectedVariantId`) funnel a
   * numeric variant id candidate through here. From this point on, behavior is
   * IDENTICAL regardless of which source discovered the change:
   *
   *   A. resolve it through the trusted Liquid variant map;
   *   B. invalidate the existing quote immediately;
   *   C. abort the active pricing request;
   *   D. update selectedVariantId/selectedVariantSku/selectedVariantAvailable and the
   *      SKU used by catalog requests;
   *   E. if the SKU changed, fetch the new SKU's catalog — never recalculate against
   *      the previous SKU's catalog, and Add to Cart stays disabled (via B, still in
   *      effect) until that new catalog's own quote succeeds;
   *   F. if only the variant id changed (same SKU), recalculate immediately against
   *      the existing, still-valid catalog;
   *   G. if the id doesn't resolve in the map, or resolves but is marked unavailable,
   *      stay failed closed — no pricing request, Add to Cart stays blocked.
   */
  PricingBlock.prototype.resolveAndAdoptVariant = function (numericId) {
    // Task 2B.2 — variant adoption is only ever safe when this block can drive dynamic
    // pricing at all. (In practice adoption is only reached from the event or
    // hidden-input paths, both of which need a resolvable section — this is the
    // defense-in-depth check requirement 5 asks for on the adoption step itself.)
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }

    // B/C
    this.invalidateSignedQuote();
    if (this.activeController) this.activeController.abort();

    // A/G
    var entry = resolveVariantFromMap(this.variantMap, numericId);
    if (!entry || !entry.available) {
      this.handleVariantUnavailable();
      return;
    }

    // D — adopt the new variant's identity FIRST, so every subsequent check (and any
    // response's quote-ownership check) compares against the real current selection.
    this.selectedVariantId = numericId;
    this.selectedVariantAvailable = entry.available;
    var skuChanged = entry.sku !== this.selectedVariantSku;
    this.selectedVariantSku = entry.sku;
    this.sku = entry.sku;
    this.clearError();

    // Task 4A.1 §4: re-evaluate readiness against the NOW-ACTIVE selection. A blank-SKU
    // variant with no Shopify product id (nothing for the server to resolve via a
    // ProductPricingOverride) fails closed here — even if the initially rendered
    // variant had a non-blank SKU.
    if (!this.canUseDynamicPricing()) {
      this.handleVariantUnavailable();
      return;
    }

    if (skuChanged) {
      // E — `fetchCatalog` replaces `this.catalog` before its own recalculation ever
      // runs, so there is no remaining path where a request goes out against the
      // previous SKU's catalog. `true` skips this one adoption-triggered
      // recalculation's own cross-check — see `_recalculateImmediate`'s doc comment.
      this.showLoading(true);
      this.fetchCatalog(true);
    } else {
      // F — same SKU, the existing catalog remains valid. Recalculates immediately
      // (not the debounced `recalculate()`): this is a single, already-validated
      // adoption, not a burst of raw keystrokes/clicks that debouncing exists for.
      this.recalculateNow(true);
    }
  };

  PricingBlock.prototype.handleVariantUnavailable = function () {
    this.selectedVariantAvailable = false;
    this.invalidateSignedQuote();
    this.hideLoading();
    this.els.error.textContent = t(this.root, MESSAGES.variantUnavailable);
    this.els.error.hidden = false;
  };

  /**
   * `seq`/`selectSeq` are optional — passed by the async rejection-handler call site in
   * `handleProductSelect` (below), where a *stale* promise (already superseded by a
   * newer variant selection) can reject well after that newer selection was already
   * adopted; without this check, that late rejection would incorrectly stomp the
   * already-valid current state with an error. The synchronous "no promise at all" call
   * site passes no sequence numbers, since that case is always current by construction
   * (it runs before any `await`, in the same turn the sequence was incremented).
   */
  PricingBlock.prototype.handleVariantSyncFailure = function (seq, selectSeq) {
    if (seq !== undefined && seq !== this.variantSelectionSequence) return;
    if (selectSeq !== undefined && selectSeq !== this.productSelectSeq) return;
    this.selectedVariantAvailable = false;
    this.invalidateSignedQuote();
    this.hideLoading();
    this.els.error.textContent = t(this.root, MESSAGES.variantSyncError);
    this.els.error.hidden = false;
  };

  /**
   * Fallback/sanity-check (Task 2B, requirement D). Reads `this.formVariantInput`'s
   * current value fresh (never cached) and, if it disagrees with `selectedVariantId`,
   * hands the candidate to `resolveAndAdoptVariant` — the SAME shared path the
   * `shopify:product:select` event uses (Task 2B.1, requirement 1: no more behavioral
   * difference between the two discovery mechanisms, and no more "recalculate against
   * the previous SKU's catalog" limitation on this path). Exists to catch the case
   * where the standard event didn't fire (e.g. a future theme change, or an older
   * Horizon build without it) but the page's own canonical variant field has genuinely
   * moved on since. Called immediately before every pricing request and immediately
   * before every Add to Cart submission — never on a timer, never speculatively.
   *
   * Returns `true` when it found a real mismatch and handed it to
   * `resolveAndAdoptVariant` (which has then already taken over recalculation itself,
   * or failed closed) — callers (`_recalculateImmediate`, `addToCart`) must NOT go on
   * to act on their own, now-superseded prior state in that case. Returns `false` when
   * there was nothing to reconcile (no reliable field, an unusable value, or the field
   * already agrees) — callers should proceed exactly as they otherwise would.
   */
  PricingBlock.prototype.crossCheckFormInput = function () {
    if (!this.formVariantInput) return false; // no reliable field found — continue on validated state alone
    var raw = this.formVariantInput.value;
    if (!isPositiveDigitString(raw)) return false; // not a usable value yet — don't destabilize state on it
    if (raw === this.selectedVariantId) return false; // consistent — nothing to reconcile

    this.resolveAndAdoptVariant(raw);
    return true;
  };

  PricingBlock.prototype.addToCart = function () {
    // Task 2B.2 — the very first check, ahead of everything (including the busy guard),
    // so a direct programmatic `addToCart()` on a block that can't safely resolve the
    // selected variant can never reach `/cart/add.js`. Fails closed loudly rather than
    // silently no-op'ing.
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }

    if (this.addToCartBusy) return;

    // Read the current selected variant fresh, one last time, before deciding anything
    // (Task 2B, requirement F.1; unified in Task 2B.1, requirement 1). This cross-check
    // is NEVER suppressed (Task 2B.1, requirement 4) — unlike a recalculation, Add to
    // Cart never passes a "skip" signal. If it finds a real mismatch, it has already
    // taken over (a fresh catalog fetch or recalculation is now in flight, or the
    // block failed closed) — this click can never proceed against the stale state it
    // had a moment ago; the customer sees the same "variant changed" messaging either
    // way and can retry once the new quote lands.
    if (this.crossCheckFormInput()) {
      this.els.addToCartStatus.textContent = t(this.root, MESSAGES.variantChanged);
      return;
    }

    var self = this;
    var quantity = this.readQuantity();
    if (!quantity.valid) return;

    // Task 4A: Add to Cart requires the current quote to be owned by BOTH the active
    // Shopify product id AND the currently selected variant id (plus SKU + an available
    // variant). Task 5B.3A adds: a held signed quote at all, an unchanged quantity, and
    // — for a v2 quote — a COMPLETE, unexpired v2 payload whose bound product/variant/
    // quantity still match. A direct programmatic `addToCart()` runs this exact check.
    var mismatch =
      !this.cartPricing ||
      this.shopifyProductId !== this.quotedProductId ||
      this.selectedVariantId !== this.quotedVariantId ||
      this.selectedVariantSku !== this.quotedVariantSku ||
      this.quotedQuantity !== quantity.value ||
      !this.selectedVariantAvailable;

    if (mismatch) {
      this.invalidateSignedQuote();
      this.els.addToCartStatus.textContent = t(this.root, MESSAGES.variantChanged);
      // Only worth kicking off a fresh quote if we actually have something valid to
      // quote for — an unavailable/unresolved selection has nothing to recalculate.
      if (this.selectedVariantId && this.selectedVariantAvailable) this.recalculate();
      return;
    }

    // Task 5B.3A — serialize the approved signed quote into cart-line properties.
    //   - v2 (production): `signedV2QuoteAttributes` — v2 ONLY, requires a complete,
    //     unexpired, owning payload; returns exactly the four private attributes
    //     UNCHANGED. The browser never constructs, edits, merges, re-signs, or submits
    //     v1 attributes on this path.
    //   - v1 (non-production transition only): the legacy serializer.
    // `null` from either → the quote is structurally unusable / stale / expired: fail
    // closed, never POST /cart/add.js.
    var isV2 = Number(this.cartPricing.version) === 2;
    var pricingProperties;
    if (isV2) {
      if (!this.v2QuoteOwns(this.cartPricing, this.quotedProductId, this.quotedVariantId, quantity.value)) {
        this.invalidateSignedQuote();
        this.els.addToCartStatus.textContent = t(this.root, MESSAGES.variantChanged);
        if (this.selectedVariantId && this.selectedVariantAvailable) this.recalculate();
        return;
      }
      pricingProperties = signedV2QuoteAttributes(this.cartPricing);
    } else {
      pricingProperties = legacyV1QuoteAttributes(this.cartPricing);
    }
    if (!pricingProperties) {
      this.invalidateSignedQuote();
      this.els.addToCartStatus.textContent = t(this.root, MESSAGES.configurationError);
      return;
    }

    // Race decision (Task 2B, requirement F, "Race decision"): once we're past the
    // checks above and the request below actually starts, the click-time quoted
    // variant wins outright — this request is never aborted just because the customer
    // changes the selector afterward, since aborting can't guarantee Shopify didn't
    // already process it server-side.
    var submittedVariantId = this.quotedVariantId;

    this.addToCartBusy = true;
    this.els.addToCart.disabled = true;
    this.els.addToCart.setAttribute("data-state", "loading");
    this.els.addToCart.textContent = t(this.root, MESSAGES.addingToCart);
    this.els.addToCartStatus.textContent = "";

    fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        items: [
          {
            id: submittedVariantId,
            quantity: quantity.value,
            properties: pricingProperties,
          },
        ],
      }),
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        self.addToCartBusy = false;
        self.els.addToCart.disabled = !self.cartPricing;
        if (result.ok) {
          self.els.addToCart.setAttribute("data-state", "success");
          self.els.addToCart.textContent = t(self.root, MESSAGES.addedToCart);
          self.els.addToCartStatus.textContent = "";
          window.setTimeout(function () {
            self.els.addToCart.removeAttribute("data-state");
            self.els.addToCart.textContent = t(self.root, MESSAGES.addToCart);
          }, 2200);
        } else {
          self.els.addToCart.setAttribute("data-state", "error");
          self.els.addToCart.textContent = t(self.root, MESSAGES.addToCart);
          self.els.addToCartStatus.textContent = t(self.root, MESSAGES.addToCartError);
        }
      })
      .catch(function () {
        self.addToCartBusy = false;
        self.els.addToCart.disabled = !self.cartPricing;
        self.els.addToCart.setAttribute("data-state", "error");
        self.els.addToCart.textContent = t(self.root, MESSAGES.addToCart);
        self.els.addToCartStatus.textContent = t(self.root, MESSAGES.addToCartError);
      });
  };

  /** Tears down this block's own listeners/in-flight work — idempotent, safe to call
   * more than once. Not currently wired to any specific Shopify lifecycle event (see
   * `bindVariantSelectListener`'s doc comment on why); exposed so it CAN be wired up
   * the moment such an event's contract is verified, and so the self-guard in
   * `handleProductSelect` has something concrete to call. */
  PricingBlock.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this._policyProbeSeq++; // discard any in-flight policy-bootstrap response
    this.lifecycleController.abort();
    if (this._sectionBindingController) this._sectionBindingController.abort();
    if (this.activeController) this.activeController.abort();
    if (this.horizonVariantObserver) {
      this.horizonVariantObserver.disconnect();
      this.horizonVariantObserver = null;
    }
    if (this.sectionReplacementObserver) {
      this.sectionReplacementObserver.disconnect();
      this.sectionReplacementObserver = null;
    }
  };

  function initAll() {
    var roots = document.querySelectorAll("[data-imprintid-pricing]");
    roots.forEach(function (root, index) {
      // Idempotent: never construct a second PricingBlock (and a second full set of
      // listeners) against a root that already has one — see Task 2B, requirement G.
      if (root.imprintIdPricingBlock && !root.imprintIdPricingBlock.destroyed) return;
      if (!root.id) root.id = "imprintid-pricing-" + index;
      root.imprintIdPricingBlock = new PricingBlock(root);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  // Task 4A.5.1 — Theme Editor / storefront section re-render inserts a fresh block root
  // with no instance. `initAll` is idempotent (skips roots that already have a live
  // block), so re-running it here safely constructs a block for the replacement root;
  // the stale instance tears itself down via its own section-lifecycle handling.
  document.addEventListener("shopify:section:load", initAll);

  window.ImprintIdPricing = { PricingBlock: PricingBlock };
})();
