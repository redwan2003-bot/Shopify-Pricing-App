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
  isPositiveDigitString,
  parseVariantMap,
  resolveVariantFromMap,
  readVariantMap,
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
    this.variantMap = parseVariantMap(root.dataset.variantMap);
    this.selectedVariantId = root.dataset.variantId || "";
    this.selectedVariantSku = root.dataset.variantSku || this.sku;
    this.selectedVariantAvailable = root.dataset.variantAvailable !== "false";
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
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
    };

    this.recalculate = debounce(this.recalculate.bind(this), DEBOUNCE_MS);
    this.init();
    this.bindVariantSelectListener();
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
    // `variantMetadataValid` is true only when a `data-variant-map` was present AND
    // parsed AND every key/entry is well-formed — Task 2B.3 folds "missing/blank" into
    // this (it is no longer a legacy bypass), so `valid` here implies `present`.
    if (!this.variantMetadataValid) return false;
    if (this.validatedVariantCount === 0) return false; // present, but `{}` — nothing to sell
    if (!this.initialVariantEntry) return false; // the initial Liquid variant isn't in the map
    if (!this.initialVariantEntry.available) return false; // ...or it is, but marked unavailable
    if (this.variantSynchronizationRequired && !this.variantSynchronizationReady) return false;
    return true;
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
    this.setCartPricing(null);
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
    this.hideLoading();
    this.els.panel.hidden = true;
    this.els.unavailable.textContent = t(this.root, MESSAGES.variantSyncError);
    this.els.unavailable.hidden = false;
  };

  PricingBlock.prototype.init = function () {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }
    if (!this.sku) {
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
  PricingBlock.prototype.fetchCatalog = function (skipCrossCheck) {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }
    var self = this;
    var seq = ++this.catalogFetchSeq;
    var url = this.proxyPath + "?sku=" + encodeURIComponent(this.sku);

    fetch(url, { headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.json().then(function (body) {
          return { status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (seq !== self.catalogFetchSeq) return; // a newer catalog fetch has already superseded this one
        if (!result.body || result.body.ok !== true) {
          self.showUnavailable();
          return;
        }
        self.catalog = result.body.data;
        self.renderCatalog();
        self.hideLoading();
        self.els.panel.hidden = false;
        self.recalculateNow(skipCrossCheck);
      })
      .catch(function () {
        if (seq !== self.catalogFetchSeq) return;
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
      noColorOption.textContent = t(this.root, "dynamic_pricing.option_none", "None");
      this.els.color.appendChild(noColorOption);
      catalog.productColors.forEach(function (color) {
        var option = document.createElement("option");
        option.value = color.code;
        option.textContent = this.formatOptionLabel(color.name, classifyResolvedPriceCents(color.priceAdjustmentCents));
        this.els.color.appendChild(option);
      }, this);
      this.els.colorWrap.hidden = false;
      this.els.color.addEventListener("change", this.recalculate);
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
    // catalog response — no group/value name is ever hardcoded here.
    this.els.optionsContainer.innerHTML = "";
    this.optionSelects = {};
    catalog.optionGroups.forEach(
      function (group) {
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

        select.addEventListener("change", this.recalculate);
        wrap.appendChild(select);
        this.els.optionsContainer.appendChild(wrap);
        this.optionSelects[group.name] = select;
      }.bind(this),
    );

    // Production: one <option> per catalog production rule — codes/labels/lead times
    // come from the API, never hardcoded.
    this.els.production.innerHTML = "";
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
    this.updateProductionHint();

    this.bindEvents();
  };

  PricingBlock.prototype.bindEvents = function () {
    this.els.quantity.addEventListener("input", this.recalculate);
    this.els.colors.addEventListener("change", this.recalculate);
    this.els.locations.addEventListener("change", this.recalculate);
    this.els.repeatOrder.addEventListener("change", this.recalculate);
    this.els.production.addEventListener("change", this.recalculate);
    this.els.production.addEventListener("change", this.updateProductionHint.bind(this));

    this.els.reverseSide.addEventListener("change", function () {
      this.els.reverseArtworkWrap.hidden = !this.els.reverseSide.checked;
      if (!this.els.reverseSide.checked) this.els.reverseArtwork.checked = false;
      this.recalculate();
    }.bind(this));
    this.els.reverseArtwork.addEventListener("change", this.recalculate);

    if (this.els.addToCart) {
      this.els.addToCart.addEventListener("click", this.addToCart.bind(this));
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

    // Only asks the server for a signed cart pricing payload when we actually know
    // which real Shopify variant this configuration is for — see
    // app/lib/pricing-api/storefront-handler.ts. Without a variant id (e.g. the block
    // was placed on a page with no resolvable product/variant), pricing preview still
    // works exactly as before; only Add to Cart stays unavailable.
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

    var quantity = this.readQuantity();
    this.els.quantityError.hidden = true;
    this.els.quantity.setAttribute("aria-invalid", "false");

    // Every recalculation invalidates whatever cart pricing payload was showing
    // before — a stale (even if still technically validly-signed) payload must never
    // be submitted for a configuration the customer has since changed away from.
    this.setCartPricing(null);
    this.quotedVariantId = null;
    this.quotedVariantSku = null;

    if (!quantity.valid) {
      this.els.quantityError.textContent = t(this.root, MESSAGES.invalidQuantity);
      this.els.quantityError.hidden = false;
      this.els.quantity.setAttribute("aria-invalid", "true");
      return;
    }

    var self = this;
    var seq = ++this.requestSeq;
    // Captured now, not re-derived from the DOM when the response arrives (Task 2B,
    // requirement E) — this is what makes the eventual quote's ownership unambiguous.
    var requestVariantId = this.selectedVariantId;
    var requestVariantSku = this.selectedVariantSku;
    var requestSelectionSeq = this.variantSelectionSequence;

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
        self.hideLoading();
        if (result.body && result.body.ok === true) {
          self.renderResult(result.body.data, requestVariantId, requestVariantSku);
        } else {
          self.renderError(result.body && result.body.error);
        }
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") return;
        if (seq !== self.requestSeq) return;
        self.hideLoading();
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

  PricingBlock.prototype.renderResult = function (data, requestVariantId, requestVariantSku) {
    // Task 2B.2 — never render a successful, addable quote for a block that can't
    // safely resolve the selected variant. (A gated `_recalculateImmediate` means this
    // is normally unreachable in that state; kept as the requirement-5 guard on the
    // "rendering a successful quote" step.)
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }

    this.els.listUnit.textContent = formatMoney(data.base.listUnitPriceCents) + " / unit";
    this.els.netUnit.textContent = formatMoney(data.base.netUnitPriceCents) + " / unit";
    this.els.total.textContent = formatMoney(data.totals.netTotalCents);
    this.setCartPricing(data.cartPricing);

    // Quote ownership (Task 2B, requirement E): recorded ONLY from the values this
    // specific request was actually sent with, never by re-reading `selectedVariantId`/
    // `selectedVariantSku` now (those may have already moved on by the time this
    // response arrives — the stale-response guard above only protects against a
    // *newer* variant selection winning the race; a same-generation response should
    // still record exactly what it was quoted for, not whatever the DOM says "currently").
    if (data.cartPricing) {
      this.quotedVariantId = requestVariantId;
      this.quotedVariantSku = requestVariantSku;
    } else {
      this.quotedVariantId = null;
      this.quotedVariantSku = null;
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
    return (
      this.root.ownerDocument.querySelector('[data-section-id="' + sectionId + '"]') ||
      this.root.ownerDocument.getElementById("shopify-section-" + sectionId) ||
      null
    );
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
    var container = this.resolveSectionContainer();
    if (!container) return null;

    return (
      container.querySelector('product-form input[name="id"]') ||
      container.querySelector('form[data-type="add-to-cart-form"] input[name="id"]') ||
      container.querySelector('form input[name="id"]') ||
      null
    );
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
    this.setCartPricing(null);
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
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
    this.setCartPricing(null);
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
    if (this.activeController) this.activeController.abort();

    // A/G
    var entry = resolveVariantFromMap(this.variantMap, numericId);
    if (!entry || !entry.available) {
      this.handleVariantUnavailable();
      return;
    }

    // D
    this.selectedVariantId = numericId;
    this.selectedVariantAvailable = true;
    this.clearError();
    var skuChanged = entry.sku !== this.selectedVariantSku;
    this.selectedVariantSku = entry.sku;
    this.sku = entry.sku;

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
    this.setCartPricing(null);
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
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
    this.setCartPricing(null);
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
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

    var mismatch =
      !this.cartPricing ||
      this.selectedVariantId !== this.quotedVariantId ||
      this.selectedVariantSku !== this.quotedVariantSku ||
      !this.selectedVariantAvailable;

    if (mismatch) {
      this.setCartPricing(null);
      this.quotedVariantId = null;
      this.quotedVariantSku = null;
      this.els.addToCartStatus.textContent = t(this.root, MESSAGES.variantChanged);
      // Only worth kicking off a fresh quote if we actually have something valid to
      // quote for — an unavailable/unresolved selection has nothing to recalculate.
      if (this.selectedVariantId && this.selectedVariantAvailable) this.recalculate();
      return;
    }

    var self = this;
    var quantity = this.readQuantity();
    if (!quantity.valid) return;

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
            properties: {
              _imprintid_pricing_version: String(this.cartPricing.version),
              _imprintid_pricing_payload: this.cartPricing.payload,
              _imprintid_pricing_signature: this.cartPricing.signature,
            },
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
    this.lifecycleController.abort();
    if (this.activeController) this.activeController.abort();
  };

  function initAll() {
    var roots = document.querySelectorAll("[data-imprintid-pricing]");
    roots.forEach(function (root, index) {
      // Idempotent: never construct a second PricingBlock (and a second full set of
      // listeners) against a root that already has one — see Task 2B, requirement G.
      if (root.imprintIdPricingBlock) return;
      if (!root.id) root.id = "imprintid-pricing-" + index;
      root.imprintIdPricingBlock = new PricingBlock(root);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  window.ImprintIdPricing = { PricingBlock: PricingBlock };
})();
