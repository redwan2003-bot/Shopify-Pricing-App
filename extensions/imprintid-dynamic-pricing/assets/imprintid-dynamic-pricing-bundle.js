function formatMoney(cents, locale) {
  if (typeof cents !== "number" || !isFinite(cents)) return "—";
  try {
    return new Intl.NumberFormat(locale || "en-US", {
      style: "currency",
      currency: "USD"
    }).format(cents / 100);
  } catch (err) {
    return "$" + (cents / 100).toFixed(2);
  }
}
function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function classifyResolvedPriceCents(resolvedPriceCents) {
  if (resolvedPriceCents === null || resolvedPriceCents === void 0) {
    return { kind: "unavailable" };
  }
  if (resolvedPriceCents === 0) {
    return { kind: "included" };
  }
  return { kind: "priced", cents: resolvedPriceCents };
}
const PRODUCT_VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/([1-9]\d*)$/;
const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/([1-9]\d*)$/;
const POSITIVE_DIGIT_STRING_PATTERN = /^[1-9]\d*$/;
function parseProductVariantGid(value) {
  if (typeof value !== "string") return null;
  const match = PRODUCT_VARIANT_GID_PATTERN.exec(value);
  return match ? match[1] : null;
}
function parseProductGid(value) {
  if (typeof value !== "string") return null;
  const match = PRODUCT_GID_PATTERN.exec(value);
  return match ? match[1] : null;
}
function isPositiveDigitString(value) {
  return typeof value === "string" && POSITIVE_DIGIT_STRING_PATTERN.test(value);
}
function parseVariantMap(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed;
}
function resolveVariantFromMap(variantMap, numericId) {
  if (!isPositiveDigitString(numericId)) return null;
  if (typeof variantMap !== "object" || variantMap === null) return null;
  const entry = variantMap[numericId];
  if (typeof entry !== "object" || entry === null) return null;
  if (typeof entry.sku !== "string" || typeof entry.available !== "boolean") return null;
  return entry;
}
function readVariantMap(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { present: false, valid: false, entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, valid: false, entries: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { present: true, valid: false, entries: [] };
  }
  const entries = [];
  for (const key of Object.keys(parsed)) {
    if (!isPositiveDigitString(key)) return { present: true, valid: false, entries: [] };
    const entry = parsed[key];
    if (typeof entry !== "object" || entry === null) return { present: true, valid: false, entries: [] };
    if (typeof entry.sku !== "string") return { present: true, valid: false, entries: [] };
    if (typeof entry.available !== "boolean") return { present: true, valid: false, entries: [] };
    entries.push({ id: key, sku: entry.sku, available: entry.available });
  }
  return { present: true, valid: true, entries };
}
function parseShopifyNumericId(value) {
  if (typeof value !== "string") return null;
  if (!POSITIVE_DIGIT_STRING_PATTERN.test(value)) return null;
  return value;
}
const ALLOWED_RESOLUTION_SOURCES = ["product_override", "sku"];
function checkResponseIdentity(identity, ctx) {
  if (!identity || typeof identity !== "object") return false;
  if (typeof identity.shopifyProductId !== "string" || identity.shopifyProductId.length === 0) return false;
  if (typeof identity.shopifyVariantId !== "string" || identity.shopifyVariantId.length === 0) return false;
  if (ALLOWED_RESOLUTION_SOURCES.indexOf(identity.resolutionSource) === -1) return false;
  if (identity.shopifyProductId !== ctx.requestProductId) return false;
  if (identity.shopifyVariantId !== ctx.requestVariantId) return false;
  if (identity.shopifyProductId !== ctx.currentProductId) return false;
  if (identity.shopifyVariantId !== ctx.currentVariantId) return false;
  if (ctx.selectedVariantSkuBlank && identity.resolutionSource !== "product_override") return false;
  return true;
}
const CART_PRICING_ATTR_NAMES = {
  version: "_imprintid_pricing_version",
  payload: "_imprintid_pricing_payload",
  signature: "_imprintid_pricing_signature",
  config: "_imprintid_pricing_config"
};
const CART_PRICING_ATTR_LIMITS = { maxPayloadBytes: 4096, maxConfigBytes: 8192 };
function utf8ByteLength(value) {
  if (typeof value !== "string") return Infinity;
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
  return unescape(encodeURIComponent(value)).length;
}
function cartLineAttributesFromSignedPricing(cartPricing) {
  if (!cartPricing || typeof cartPricing !== "object") return null;
  const version = Number(cartPricing.version);
  if (version !== 1 && version !== 2) return null;
  if (typeof cartPricing.payload !== "string" || cartPricing.payload.length === 0) return null;
  if (typeof cartPricing.signature !== "string" || cartPricing.signature.length === 0) return null;
  if (utf8ByteLength(cartPricing.payload) > CART_PRICING_ATTR_LIMITS.maxPayloadBytes) return null;
  const props = {};
  props[CART_PRICING_ATTR_NAMES.version] = String(version);
  props[CART_PRICING_ATTR_NAMES.payload] = cartPricing.payload;
  props[CART_PRICING_ATTR_NAMES.signature] = cartPricing.signature;
  if (version === 2) {
    if (typeof cartPricing.config !== "string" || cartPricing.config.length === 0) return null;
    if (utf8ByteLength(cartPricing.config) > CART_PRICING_ATTR_LIMITS.maxConfigBytes) return null;
    props[CART_PRICING_ATTR_NAMES.config] = cartPricing.config;
  }
  return props;
}
const V2_QUOTE_TTL_SECONDS = 30 * 60;
const V2_PAYLOAD_FIELDS = [
  "v",
  "installBinding",
  "productGid",
  "variantGid",
  "quantity",
  "currency",
  "baseUnitPriceCents",
  "perUnitSurchargeCents",
  "flatSurchargeCents",
  "lineTotalCents",
  "adjustmentVariantGid",
  "profileRef",
  "profileRevision",
  "policyRevision",
  "configDigest",
  "quoteId",
  "issuedAtServer"
];
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isNonNegSafeInt(v) {
  return typeof v === "number" && Number.isInteger(v) && Number.isSafeInteger(v) && v >= 0;
}
function readSignedV2Quote(cartPricing) {
  if (!cartPricing || typeof cartPricing !== "object") return { ok: false, reason: "missing" };
  if (Number(cartPricing.version) !== 2) return { ok: false, reason: "not_v2" };
  if (!isNonEmptyString(cartPricing.payload)) return { ok: false, reason: "missing" };
  if (!isNonEmptyString(cartPricing.signature)) return { ok: false, reason: "missing" };
  if (!isNonEmptyString(cartPricing.config)) return { ok: false, reason: "missing" };
  if (utf8ByteLength(cartPricing.payload) > CART_PRICING_ATTR_LIMITS.maxPayloadBytes) return { ok: false, reason: "too_large" };
  if (utf8ByteLength(cartPricing.config) > CART_PRICING_ATTR_LIMITS.maxConfigBytes) return { ok: false, reason: "too_large" };
  var parsed;
  try {
    parsed = JSON.parse(cartPricing.payload);
  } catch (e) {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "malformed" };
  var keys = Object.keys(parsed);
  if (keys.length !== V2_PAYLOAD_FIELDS.length) return { ok: false, reason: "unknown_fields" };
  for (var i = 0; i < V2_PAYLOAD_FIELDS.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(parsed, V2_PAYLOAD_FIELDS[i])) return { ok: false, reason: "missing_field" };
  }
  if (parsed.v !== 2) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.installBinding)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.productGid)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.variantGid)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.quantity) || parsed.quantity < 1) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.currency)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.baseUnitPriceCents)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.perUnitSurchargeCents)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.flatSurchargeCents)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.lineTotalCents)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.adjustmentVariantGid)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.profileRef)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.profileRevision)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.policyRevision)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.configDigest)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(parsed.quoteId)) return { ok: false, reason: "malformed" };
  if (!isNonNegSafeInt(parsed.issuedAtServer)) return { ok: false, reason: "malformed" };
  return { ok: true, payload: parsed };
}
function isSignedV2QuoteExpired(payload, nowSeconds) {
  if (!payload || typeof payload.issuedAtServer !== "number") return true;
  return nowSeconds > payload.issuedAtServer + V2_QUOTE_TTL_SECONDS;
}
function signedV2QuoteAttributes(cartPricing) {
  var check = readSignedV2Quote(cartPricing);
  if (!check.ok) return null;
  var props = {};
  props[CART_PRICING_ATTR_NAMES.version] = "2";
  props[CART_PRICING_ATTR_NAMES.payload] = cartPricing.payload;
  props[CART_PRICING_ATTR_NAMES.signature] = cartPricing.signature;
  props[CART_PRICING_ATTR_NAMES.config] = cartPricing.config;
  return props;
}
function legacyV1QuoteAttributes(cartPricing) {
  if (!cartPricing || typeof cartPricing !== "object") return null;
  if (Number(cartPricing.version) !== 1) return null;
  if (typeof cartPricing.payload !== "string") return null;
  var parsed;
  try {
    parsed = JSON.parse(cartPricing.payload);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
  return cartLineAttributesFromSignedPricing(cartPricing);
}
(function() {
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
    variantSyncError: "dynamic_pricing.variant_sync_error"
  };
  var QUANTITY_ERROR_CODES = ["INVALID_QUANTITY", "QUANTITY_BELOW_MINIMUM"];
  var UNSUPPORTED_ERROR_CODES = [
    "STORE_NOT_FOUND",
    "PRICING_PROFILE_NOT_FOUND",
    "PRICING_PROFILE_INACTIVE",
    "SHOP_NOT_AVAILABLE"
  ];
  var PRODUCT_SELECT_EVENT = "shopify:product:select";
  var formatMoney$1 = function(cents) {
    return formatMoney(cents, document.documentElement.lang);
  };
  function fetchWithRetry(url, options, attempts, timeoutMs) {
    var attempt = 0;
    function once() {
      attempt += 1;
      var controller = new AbortController();
      var timer = window.setTimeout(function() {
        controller.abort();
      }, timeoutMs);
      var opts = {};
      for (var k in options) if (Object.prototype.hasOwnProperty.call(options, k)) opts[k] = options[k];
      opts.signal = controller.signal;
      return fetch(url, opts).then(
        function(response) {
          window.clearTimeout(timer);
          if ([502, 503, 504].indexOf(response.status) !== -1 && attempt < attempts) return retryLater();
          return response;
        },
        function(error) {
          window.clearTimeout(timer);
          if (attempt < attempts) return retryLater();
          throw error;
        }
      );
    }
    function retryLater() {
      return new Promise(function(resolve) {
        window.setTimeout(resolve, 600 * attempt);
      }).then(once);
    }
    return once();
  }
  function t(root, key, fallback) {
    var dict = window.ImprintIdPricingStrings || {};
    return dict[key] || fallback || key;
  }
  function qs(root, selector) {
    return root.querySelector(selector);
  }
  var EXCLUDED_FORM_CONTEXT_SELECTOR = "quick-add-modal,quick-add,quick-order-list,[data-quick-add],product-card,.product-card,.card-product,.card--product,[data-product-card],product-recommendations,.product-recommendations,recommended-products,.complementary-products,.complementary-products__container";
  function isExcludedFormContext(el) {
    try {
      return !!(el && typeof el.closest === "function" && el.closest(EXCLUDED_FORM_CONTEXT_SELECTOR));
    } catch (e) {
      return false;
    }
  }
  function formInputRank(input) {
    try {
      if (input.closest("product-form")) return 0;
      if (input.closest('form[data-type="add-to-cart-form"]')) return 1;
    } catch (e) {
    }
    return 2;
  }
  var NATIVE_SUBMIT_SELECTOR = 'button[type="submit"],input[type="submit"],button[name="add"],input[name="add"],button:not([type])';
  var STICKY_WRAPPER_SELECTOR = "sticky-buy-buttons,sticky-atc,sticky-cart,[data-sticky-buy-buttons],[data-sticky-atc],.sticky-buy-buttons,.sticky-atc,.sticky-add-to-cart,.product-sticky,.product-form--sticky";
  function cssEscapeIdent(value) {
    var s = String(value == null ? "" : value);
    try {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
    } catch (e) {
    }
    return s.replace(/[^\w-]/g, function(ch) {
      return "\\" + ch;
    });
  }
  function debounce(fn, ms) {
    var timer = null;
    return function() {
      var args = arguments;
      var self = this;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function() {
        fn.apply(self, args);
      }, ms);
    };
  }
  function PricingBlock(root) {
    this.root = root;
    this.sku = root.dataset.sku || "";
    this.proxyPath = root.dataset.proxyPath || "/apps/imprintid-pricing/pricing";
    this.catalog = null;
    this.catalogSku = null;
    this.requestSeq = 0;
    this.activeController = null;
    this.cartPricing = null;
    this.productGid = root.dataset.productGid || "";
    this.shopifyProductId = parseShopifyNumericId(root.dataset.shopifyProductId) || "";
    this.pricingEnforcementIntended = this.shopifyProductId.length > 0;
    this._enforcementState = "block";
    this._policyProbeInFlight = false;
    this._policyProbeSeq = 0;
    this.variantMap = parseVariantMap(root.dataset.variantMap);
    this.selectedVariantId = root.dataset.variantId || "";
    this.selectedVariantSku = root.dataset.variantSku != null ? root.dataset.variantSku : this.sku;
    this.selectedVariantAvailable = root.dataset.variantAvailable !== "false";
    this.quotedProductId = null;
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
    this.quotedQuantity = null;
    this.configSeq = 0;
    this.variantSelectionSequence = 0;
    this.productSelectSeq = 0;
    this.catalogFetchSeq = 0;
    this.formVariantInput = this.resolveFormVariantInput();
    this.lifecycleController = new AbortController();
    this.destroyed = false;
    this._sectionId = this.root.dataset.sectionId || "";
    this._sectionBindingController = null;
    this._boundOwnerForm = null;
    this._boundOwnerPicker = null;
    this._sectionScopeMasterBound = false;
    this._nativeControlClickGuard = this.handleContainedControlClick.bind(this);
    this._nativeFormSubmitGuard = this.handleContainedFormSubmit.bind(this);
    this.horizonVariantObserver = null;
    this.sectionReplacementObserver = null;
    var mapInfo = readVariantMap(this.root.dataset.variantMap);
    this.variantMapInfo = mapInfo;
    this.variantMetadataValid = mapInfo.valid;
    this.validatedVariantCount = mapInfo.entries.length;
    this.initialVariantEntry = null;
    for (var vi = 0; vi < mapInfo.entries.length; vi++) {
      if (mapInfo.entries[vi].id === this.selectedVariantId) {
        this.initialVariantEntry = mapInfo.entries[vi];
        break;
      }
    }
    if (this.initialVariantEntry) {
      this.selectedVariantSku = this.initialVariantEntry.sku;
      this.selectedVariantAvailable = this.initialVariantEntry.available;
    }
    this.variantSynchronizationRequired = this.variantMetadataValid && this.validatedVariantCount > 1;
    this.variantSynchronizationReady = !this.variantSynchronizationRequired || this.resolveSectionContainer() != null;
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
      infoError: qs(root, "[data-imprintid-pricing-info-error]"),
      quoteError: qs(root, "[data-imprintid-pricing-quote-error]"),
      productionWrap: qs(root, "[data-imprintid-pricing-production-wrap]")
    };
    this.recalculate = debounce(this.recalculate.bind(this), DEBOUNCE_MS);
    this._now = function() {
      return Math.floor(Date.now() / 1e3);
    };
    this.onConfigInput = (function() {
      this.configSeq++;
      this.invalidateSignedQuote();
      this.recalculate();
    }).bind(this);
    this.init();
    this.bindVariantSelectListener();
    this.bindSectionScope();
  }
  PricingBlock.prototype.canUseDynamicPricing = function() {
    if (!this.variantMetadataValid) return false;
    if (this.validatedVariantCount === 0) return false;
    if (!this.initialVariantEntry) return false;
    if (this.variantSynchronizationRequired && !this.variantSynchronizationReady) return false;
    if (!this.selectedVariantAvailable) return false;
    if (!this.selectedVariantSku && !this.shopifyProductId) return false;
    return true;
  };
  PricingBlock.prototype.renderIdentityFailure = function() {
    this.invalidateSignedQuote();
    this.hideLoading();
    var msg = t(this.root, MESSAGES.configurationError);
    this.els.error.textContent = msg;
    this.els.error.hidden = false;
    if (this.els.panel.hidden) {
      this.els.unavailable.textContent = msg;
      this.els.unavailable.hidden = false;
    }
  };
  PricingBlock.prototype.responseIdentityOk = function(identity, requestProductId, requestVariantId) {
    if (!this.shopifyProductId) return true;
    return checkResponseIdentity(identity, {
      requestProductId,
      requestVariantId,
      currentProductId: this.shopifyProductId,
      currentVariantId: this.selectedVariantId,
      selectedVariantSkuBlank: !this.selectedVariantSku
    });
  };
  PricingBlock.prototype.failClosedForSync = function() {
    if (!this.variantSyncUnavailable) {
      console.warn(
        "[dynamic-pricing] Variant synchronization is unavailable for this block (a multi-variant product whose owning Shopify section could not be resolved, or inconsistent variant metadata). Add to Cart is disabled and no catalog or pricing request will be made. No product, variant, or secret data is included in this message."
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
  PricingBlock.prototype.init = function() {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      this.probeEnforcementState();
      return;
    }
    if (!this.sku && !this.shopifyProductId) {
      this.showUnavailable();
      return;
    }
    this.showLoading(true);
    this.fetchCatalog();
  };
  PricingBlock.prototype.showUnavailable = function() {
    this.els.unavailable.hidden = false;
    this.els.loading.hidden = true;
    this.els.panel.hidden = true;
    this.probeEnforcementState();
  };
  PricingBlock.prototype.probeEnforcementState = function() {
    if (this.destroyed || !this.shopifyProductId || this._policyProbeInFlight) return;
    this._policyProbeInFlight = true;
    var self = this;
    var seq = ++this._policyProbeSeq;
    var probeProductId = this.shopifyProductId;
    var url = this.proxyPath + (this.proxyPath.indexOf("?") === -1 ? "?" : "&") + "policyOnly=1&shopifyProductId=" + encodeURIComponent(this.shopifyProductId);
    fetch(url, { headers: { Accept: "application/json" } }).then(function(response) {
      return response.json();
    }).then(function(body) {
      self._policyProbeInFlight = false;
      if (self.destroyed || seq !== self._policyProbeSeq || probeProductId !== self.shopifyProductId) return;
      if (!body || body.ok !== true || !body.data || !body.data.enforcement) return;
      self.updateEnforcementState(body.data.enforcement.state);
      if (body.data.enforcement.state === "bypass" && self.els.panel.hidden) self.root.hidden = true;
    }).catch(function() {
      self._policyProbeInFlight = false;
    });
  };
  PricingBlock.prototype.showLoading = function(isInitialLoad) {
    this.root.setAttribute("data-loading", "true");
    if (isInitialLoad) {
      this.els.loading.hidden = false;
      this.els.panel.hidden = true;
      var self = this;
      window.clearTimeout(this._slowLoadTimer);
      this._slowLoadTimer = window.setTimeout(function() {
        if (!self.els.loading.hidden) {
          self.els.loading.textContent = t(self.root, "dynamic_pricing.loading_slow", "Still loading. The first request after a quiet period can take a little longer.");
        }
      }, 6e3);
    }
  };
  PricingBlock.prototype.hideLoading = function() {
    window.clearTimeout(this._slowLoadTimer);
    this.root.removeAttribute("data-loading");
    this.els.loading.hidden = true;
  };
  PricingBlock.prototype.fetchCatalog = function(skipCrossCheck) {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }
    var self = this;
    var seq = ++this.catalogFetchSeq;
    var url = this.proxyPath + "?sku=" + encodeURIComponent(this.sku);
    if (this.shopifyProductId) url += "&shopifyProductId=" + encodeURIComponent(this.shopifyProductId);
    if (this.selectedVariantId) url += "&shopifyVariantId=" + encodeURIComponent(this.selectedVariantId);
    var requestProductId = this.shopifyProductId;
    var requestVariantId = this.selectedVariantId;
    var requestVariantSku = this.selectedVariantSku;
    fetchWithRetry(url, { headers: { Accept: "application/json" } }, 3, 3e4).then(function(response) {
      return response.json().then(function(body) {
        return { status: response.status, body };
      });
    }).then(function(result) {
      if (seq !== self.catalogFetchSeq) return;
      if (result.body && result.body.ok === true && result.body.data) {
        self.updateEnforcementState(result.body.data.enforcement && result.body.data.enforcement.state);
      }
      if (!result.body || result.body.ok !== true) {
        self.showUnavailable();
        return;
      }
      if (!self.responseIdentityOk(result.body.data && result.body.data.identity, requestProductId, requestVariantId)) {
        self.renderIdentityFailure();
        return;
      }
      self.catalog = result.body.data;
      self.catalogSku = requestVariantSku;
      self.renderCatalog();
      self.hideLoading();
      self.els.panel.hidden = false;
      self.recalculateNow(skipCrossCheck);
    }).catch(function() {
      if (seq !== self.catalogFetchSeq) return;
      self.showUnavailable();
    });
  };
  PricingBlock.prototype.applyDecorationCapabilities = function(capabilities) {
    var els = this.els;
    var caps = capabilities || { maxColors: 1, secondLocation: false, reverseSide: false, repeatOrder: false };
    var fieldOf = function(control) {
      return control && control.closest ? control.closest(".imprintid-pricing__field") : null;
    };
    var setShown = function(control, shown) {
      var field = fieldOf(control);
      if (field) field.hidden = !shown;
    };
    els.colors.replaceChildren();
    for (var n = 1; n <= caps.maxColors; n++) {
      var opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = n === 1 ? t(this.root, "dynamic_pricing.colors_one", "1 color") : n === 2 ? t(this.root, "dynamic_pricing.colors_two", "2 colors") : n + " colors";
      els.colors.appendChild(opt);
    }
    els.colors.value = "1";
    setShown(els.colors, caps.maxColors > 1);
    if (!caps.secondLocation) els.locations.value = "1";
    setShown(els.locations, caps.secondLocation);
    if (!caps.reverseSide) {
      els.reverseSide.checked = false;
      els.reverseArtwork.checked = false;
      els.reverseArtworkWrap.hidden = true;
    }
    setShown(els.reverseSide, caps.reverseSide);
    if (!caps.repeatOrder) els.repeatOrder.checked = false;
    setShown(els.repeatOrder, caps.repeatOrder);
    els.decorationFieldset.hidden = !(caps.maxColors > 1 || caps.secondLocation || caps.reverseSide || caps.repeatOrder);
  };
  PricingBlock.prototype.renderCatalog = function() {
    var catalog = this.catalog;
    if (catalog.quantityTiers.length) {
      var lowest = catalog.quantityTiers[0];
      this.els.quantity.min = String(lowest.minQuantity);
      this.els.quantity.value = String(lowest.minQuantity);
    }
    if (catalog.productColors && catalog.productColors.length) {
      this.els.color.innerHTML = "";
      var noColorOption = document.createElement("option");
      noColorOption.value = "";
      noColorOption.textContent = t(this.root, "dynamic_pricing.color_placeholder", "Color");
      this.els.color.appendChild(noColorOption);
      catalog.productColors.forEach(function(color) {
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
    if (catalog.decorationMethods.length) {
      this.decorationMethod = catalog.decorationMethods[0];
      var capabilities = null;
      var capabilityList = catalog.decorationCapabilities || [];
      for (var ci = 0; ci < capabilityList.length; ci++) {
        if (capabilityList[ci].method === this.decorationMethod) capabilities = capabilityList[ci];
      }
      this.applyDecorationCapabilities(capabilities);
    } else {
      this.els.decorationFieldset.hidden = true;
      this.decorationMethod = null;
    }
    this.els.optionsContainer.innerHTML = "";
    this.optionSelects = {};
    var buildOptionField = (function(group) {
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
      group.values.forEach(function(value) {
        var option = document.createElement("option");
        option.value = value.id;
        var shownCents = typeof value.resolvedNetPriceCents === "number" ? value.resolvedNetPriceCents : value.resolvedPriceCents;
        option.textContent = this.formatOptionLabel(value.label, classifyResolvedPriceCents(shownCents));
        select.appendChild(option);
      }, this);
      select.addEventListener("change", this.onConfigInput);
      wrap.appendChild(select);
      this.optionSelects[group.name] = select;
      return wrap;
    }).bind(this);
    var attachmentGroups = catalog.optionGroups.filter(function(group) {
      return group.kind === "ATTACHMENT";
    });
    var otherGroups = catalog.optionGroups.filter(function(group) {
      return group.kind !== "ATTACHMENT";
    });
    var appendOptionPanel = (function(groups, key, fallback, className) {
      if (!groups.length) return;
      var details = document.createElement("details");
      details.className = "imprintid-pricing__dropdown " + className;
      var summary = document.createElement("summary");
      summary.textContent = t(this.root, key, fallback);
      details.appendChild(summary);
      var content = document.createElement("div");
      content.className = "imprintid-pricing__dropdown-content";
      groups.forEach(function(group) {
        content.appendChild(buildOptionField(group));
      });
      details.appendChild(content);
      this.els.optionsContainer.appendChild(details);
    }).bind(this);
    appendOptionPanel(attachmentGroups, "dynamic_pricing.attachments_placeholder", "Attachments", "imprintid-pricing__dropdown--attachments");
    appendOptionPanel(otherGroups, "dynamic_pricing.optional_features_placeholder", "Optional Features", "imprintid-pricing__dropdown--features");
    this.els.production.innerHTML = "";
    if (catalog.productionRules.length) {
      catalog.productionRules.forEach(function(rule) {
        var option = document.createElement("option");
        option.value = rule.code;
        var lead = rule.minBusinessDays === rule.maxBusinessDays || !rule.maxBusinessDays ? rule.minBusinessDays + "d" : rule.minBusinessDays + "-" + rule.maxBusinessDays + "d";
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
  PricingBlock.prototype.bindEvents = function() {
    this.els.quantity.addEventListener("input", this.onConfigInput);
    this.els.colors.addEventListener("change", this.onConfigInput);
    this.els.locations.addEventListener("change", this.onConfigInput);
    this.els.repeatOrder.addEventListener("change", this.onConfigInput);
    this.els.production.addEventListener("change", this.onConfigInput);
    this.els.production.addEventListener("change", this.updateProductionHint.bind(this));
    this.els.reverseSide.addEventListener("change", (function() {
      this.els.reverseArtworkWrap.hidden = !this.els.reverseSide.checked;
      if (!this.els.reverseSide.checked) this.els.reverseArtwork.checked = false;
      this.onConfigInput();
    }).bind(this));
    this.els.reverseArtwork.addEventListener("change", this.onConfigInput);
    if (this.els.addToCart) {
      this.els.addToCart.addEventListener("click", this.addToCart.bind(this));
    }
    this.bindModals();
  };
  PricingBlock.prototype.bindModals = function() {
    var self = this;
    var closeOnBackdropClick = function(dialog) {
      dialog.addEventListener("click", function(e) {
        if (e.target === dialog) dialog.close();
      });
    };
    var bindCloseButtons = function(dialog) {
      var closeBtns = dialog.querySelectorAll("[data-imprintid-pricing-modal-close]");
      for (var i = 0; i < closeBtns.length; i++) {
        closeBtns[i].addEventListener("click", function() {
          dialog.close();
        });
      }
    };
    if (this.els.requestInfoBtn && this.els.infoModal) {
      this.els.requestInfoBtn.addEventListener("click", function() {
        if (self.els.infoSuccess) self.els.infoSuccess.hidden = true;
        if (self.els.infoError) self.els.infoError.hidden = true;
        if (self.els.infoForm) self.els.infoForm.reset();
        self.els.infoModal.showModal();
      });
      closeOnBackdropClick(this.els.infoModal);
      bindCloseButtons(this.els.infoModal);
      if (this.els.infoForm) {
        this.els.infoForm.addEventListener("submit", function(e) {
          e.preventDefault();
          self.submitInquiry("info", self.els.infoForm, self.els.infoSuccess, self.els.infoError, self.els.infoModal);
        });
      }
    }
    if (this.els.requestQuoteBtn && this.els.quoteModal) {
      this.els.requestQuoteBtn.addEventListener("click", function() {
        if (self.els.quoteSuccess) self.els.quoteSuccess.hidden = true;
        if (self.els.quoteError) self.els.quoteError.hidden = true;
        if (self.els.quoteForm) self.els.quoteForm.reset();
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
        this.els.quoteForm.addEventListener("submit", function(e) {
          e.preventDefault();
          self.submitInquiry("quote", self.els.quoteForm, self.els.quoteSuccess, self.els.quoteError, self.els.quoteModal);
        });
      }
    }
  };
  PricingBlock.prototype.inquiryUrl = function() {
    return this.proxyPath.replace(/\/pricing(\?.*)?$/, "/inquiry");
  };
  PricingBlock.prototype.snapshotConfiguration = function() {
    var snapshot = { displayedTotal: this.els.total ? this.els.total.textContent.trim() : null };
    try {
      snapshot.request = this.buildRequestBody();
    } catch (e) {
    }
    return snapshot;
  };
  PricingBlock.prototype.submitInquiry = function(kind, form, successEl, errorEl, modal) {
    var self = this;
    var value = function(name) {
      var el = form.elements[name];
      return el ? String(el.value || "").trim() : "";
    };
    var submit = form.querySelector('button[type="submit"]');
    var showError = function(message) {
      if (submit) submit.disabled = false;
      if (errorEl) {
        errorEl.textContent = message || t(self.root, "dynamic_pricing.inquiry_error", "We could not send your message. Please try again in a moment.");
        errorEl.hidden = false;
      }
    };
    if (errorEl) errorEl.hidden = true;
    if (successEl) successEl.hidden = true;
    if (submit) submit.disabled = true;
    var payload = {
      kind,
      name: value("name"),
      email: value("email"),
      message: value("message"),
      quantity: value("quantity") || void 0,
      website: value("website"),
      shopifyProductId: this.shopifyProductId || void 0,
      shopifyVariantId: this.selectedVariantId || void 0,
      sku: this.selectedVariantSku || this.sku || void 0,
      configuration: this.snapshotConfiguration()
    };
    fetchWithRetry(
      this.inquiryUrl(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      },
      1,
      6e4
    ).then(function(response) {
      return response.json().then(
        function(body) {
          return { ok: response.ok && !!body && body.ok === true, body };
        },
        function() {
          return { ok: false, body: null };
        }
      );
    }).then(function(result) {
      if (!result.ok) {
        showError(result.body && result.body.error && result.body.error.message);
        return;
      }
      if (submit) submit.disabled = false;
      form.reset();
      if (successEl) successEl.hidden = false;
      window.setTimeout(function() {
        if (modal && modal.open) modal.close();
      }, 2500);
    }).catch(function() {
      showError(null);
    });
  };
  PricingBlock.prototype.formatOptionLabel = function(label, priceDescription) {
    if (priceDescription.kind === "priced") {
      var sign = priceDescription.cents > 0 ? "+" : "";
      return label + " — " + sign + formatMoney$1(priceDescription.cents) + " / unit";
    }
    if (priceDescription.kind === "included") {
      return label + " — " + t(this.root, "dynamic_pricing.option_included", "Included");
    }
    return label + " — " + t(this.root, "dynamic_pricing.option_price_unavailable", "price unavailable");
  };
  PricingBlock.prototype.updateProductionHint = function() {
    if (!this.catalog) return;
    var code = this.els.production.value;
    var rule = this.catalog.productionRules.filter(function(r) {
      return r.code === code;
    })[0];
    if (rule && rule.relatedSku) {
      this.els.productionHint.textContent = t(
        this.root,
        "dynamic_pricing.related_sku_hint",
        "Related SKU: {sku}"
      ).replace("{sku}", rule.relatedSku);
      this.els.productionHint.hidden = false;
    } else if (rule && rule.notes) {
      this.els.productionHint.textContent = rule.notes;
      this.els.productionHint.hidden = false;
    } else {
      this.els.productionHint.hidden = true;
    }
  };
  PricingBlock.prototype.readQuantity = function() {
    var raw = this.els.quantity.value;
    var n = parseInt(raw, 10);
    return { raw, value: n, valid: raw !== "" && Number.isFinite(n) && n > 0 };
  };
  PricingBlock.prototype.buildRequestBody = function() {
    var quantity = this.readQuantity();
    var body = { sku: this.sku, quantity: quantity.value };
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
        reverseSide,
        differentReverseArtwork: reverseSide && this.els.reverseArtwork.checked,
        repeatOrder: this.els.repeatOrder.checked
      };
    }
    var options = [];
    Object.keys(this.optionSelects || {}).forEach(
      (function(groupName) {
        var select = this.optionSelects[groupName];
        if (select.value) {
          options.push({ groupName, optionValueId: select.value });
        }
      }).bind(this)
    );
    if (options.length) body.options = options;
    if (this.els.production.value) {
      body.production = { code: this.els.production.value };
    }
    return body;
  };
  PricingBlock.prototype.recalculateNow = function(skipCrossCheck) {
    this._recalculateImmediate(skipCrossCheck);
  };
  PricingBlock.prototype.recalculate = function() {
    this._recalculateImmediate(false);
  };
  PricingBlock.prototype._recalculateImmediate = function(skipCrossCheck) {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }
    if (!skipCrossCheck && this.crossCheckFormInput()) {
      return;
    }
    if (this.catalog && this.catalogSku !== this.selectedVariantSku) {
      this.invalidateSignedQuote();
      this.showUnavailable();
      return;
    }
    var quantity = this.readQuantity();
    this.els.quantityError.hidden = true;
    this.els.quantity.setAttribute("aria-invalid", "false");
    this.invalidateSignedQuote();
    if (!quantity.valid) {
      this.els.quantityError.textContent = t(this.root, MESSAGES.invalidQuantity);
      this.els.quantityError.hidden = false;
      this.els.quantity.setAttribute("aria-invalid", "true");
      return;
    }
    var self = this;
    var seq = ++this.requestSeq;
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
      signal: controller.signal
    }).then(function(response) {
      return response.json().then(function(body) {
        return { status: response.status, body };
      });
    }).then(function(result) {
      if (seq !== self.requestSeq) return;
      if (requestSelectionSeq !== self.variantSelectionSequence) return;
      if (requestConfigSeq !== self.configSeq) return;
      self.hideLoading();
      if (result.body && result.body.ok === true) {
        if (result.body.data && result.body.data.enforcement) {
          self.updateEnforcementState(result.body.data.enforcement.state);
        }
        if (!self.responseIdentityOk(result.body.data && result.body.data.identity, requestProductId, requestVariantId)) {
          self.renderIdentityFailure();
          return;
        }
        self.renderResult(result.body.data, requestProductId, requestVariantId, requestVariantSku, requestQuantity);
      } else {
        self.renderError(result.body && result.body.error);
      }
    }).catch(function(err) {
      if (err && err.name === "AbortError") return;
      if (seq !== self.requestSeq) return;
      self.hideLoading();
      self.renderError(null);
    });
  };
  PricingBlock.prototype.clearError = function() {
    this.els.error.hidden = true;
    this.els.error.textContent = "";
  };
  PricingBlock.prototype.renderError = function(error) {
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
  PricingBlock.prototype.setCartPricing = function(cartPricing) {
    this.cartPricing = cartPricing || null;
    if (!this.els.addToCart) return;
    this.els.addToCart.disabled = !this.cartPricing;
    this.els.addToCart.removeAttribute("data-state");
    this.els.addToCartStatus.textContent = this.cartPricing ? "" : t(this.root, MESSAGES.addToCartUnavailable);
  };
  PricingBlock.prototype.invalidateSignedQuote = function() {
    this.setCartPricing(null);
    this.quotedProductId = null;
    this.quotedVariantId = null;
    this.quotedVariantSku = null;
    this.quotedQuantity = null;
  };
  PricingBlock.prototype.v2QuoteOwns = function(cartPricing, productId, variantId, quantity) {
    var check = readSignedV2Quote(cartPricing);
    if (!check.ok) return false;
    if (parseProductVariantGid(check.payload.variantGid) !== variantId) return false;
    if (parseProductGid(check.payload.productGid) !== productId) return false;
    if (check.payload.quantity !== quantity) return false;
    if (isSignedV2QuoteExpired(check.payload, this._now())) return false;
    return true;
  };
  PricingBlock.prototype.renderResult = function(data, requestProductId, requestVariantId, requestVariantSku, requestQuantity) {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }
    if (!this.responseIdentityOk(data.identity, requestProductId, requestVariantId)) {
      this.renderIdentityFailure();
      return;
    }
    this.els.listUnit.textContent = formatMoney$1(data.base.listUnitPriceCents) + " / unit";
    this.els.netUnit.textContent = formatMoney$1(data.base.netUnitPriceCents) + " / unit";
    this.els.total.textContent = formatMoney$1(data.totals.netTotalCents);
    var quoteReady = false;
    if (data.cartPricing && Number(data.cartPricing.version) === 2) {
      quoteReady = this.v2QuoteOwns(data.cartPricing, requestProductId, requestVariantId, requestQuantity);
    } else if (data.cartPricing) {
      quoteReady = !!legacyV1QuoteAttributes(data.cartPricing);
    }
    this.setCartPricing(quoteReady ? data.cartPricing : null);
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
      String(data.quantityTier.minQuantity)
    );
    this.renderTierTable(data.availableQuantityTiers, data.quantityTier);
    this.renderBreakdown(data);
  };
  PricingBlock.prototype.renderTierTable = function(tiers, selectedTier) {
    if (!tiers || !tiers.length) {
      this.els.tierTable.hidden = true;
      return;
    }
    this.els.tierTableBody.innerHTML = "";
    tiers.forEach(function(tier) {
      var row = document.createElement("tr");
      if (selectedTier && tier.id === selectedTier.id) {
        row.setAttribute("aria-current", "true");
      }
      var qtyCell = document.createElement("th");
      qtyCell.setAttribute("scope", "row");
      qtyCell.textContent = tier.minQuantity + "+";
      var listCell = document.createElement("td");
      listCell.textContent = formatMoney$1(tier.listUnitPriceCents);
      var netCell = document.createElement("td");
      netCell.textContent = formatMoney$1(tier.netUnitPriceCents);
      row.appendChild(qtyCell);
      row.appendChild(listCell);
      row.appendChild(netCell);
      this.els.tierTableBody.appendChild(row);
    }, this);
    this.els.tierTable.hidden = false;
  };
  PricingBlock.prototype.renderBreakdown = function(data) {
    var list = this.els.breakdownList;
    var root = this.root;
    list.innerHTML = "";
    var addRow = function(labelKey, fallback, cents) {
      var dt = document.createElement("dt");
      dt.textContent = t(root, labelKey, fallback);
      var dd = document.createElement("dd");
      dd.textContent = formatMoney$1(cents);
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
      addRow("dynamic_pricing.breakdown_options", "Options", data.options.netChargesCents);
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
  PricingBlock.prototype.resolveSectionContainer = function() {
    var sectionId = this.root.dataset.sectionId;
    if (!sectionId) return null;
    var doc = this.root.ownerDocument;
    var wrapper = doc.getElementById("shopify-section-" + sectionId);
    if (wrapper) return wrapper;
    var self = this;
    var marked = doc.querySelectorAll('[data-section-id="' + sectionId + '"]');
    var container = null;
    for (var i = 0; i < marked.length; i++) {
      var el = marked[i];
      if (el === self.root || !el.contains(self.root)) continue;
      if (!container || container.contains(el)) container = el;
    }
    return container;
  };
  PricingBlock.prototype.resolveFormVariantInput = function() {
    var resolved = this.resolveOwnedProductFormInput();
    this.variantOwnershipAmbiguous = resolved.ambiguous;
    return resolved.input;
  };
  PricingBlock.prototype.resolveOwnedProductFormInput = function() {
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
    candidates.sort(function(a, b) {
      return formInputRank(a) - formInputRank(b);
    });
    var best = candidates[0];
    var bestRank = formInputRank(best);
    var peers = candidates.filter(function(c) {
      return formInputRank(c) === bestRank;
    });
    if (peers.length > 1) {
      var v = best.value;
      var allAgree = peers.every(function(c) {
        return c.value === v;
      });
      if (!allAgree) return { input: null, ambiguous: true };
    }
    return { input: best, ambiguous: false };
  };
  PricingBlock.prototype.resolveOwnedVariantPicker = function() {
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
      var matched = candidates.filter(function(p) {
        var pid = p.getAttribute("data-product-id") || "";
        return pid && String(parseShopifyNumericId(pid) || "") === String(wanted);
      });
      if (matched.length === 1) return { picker: matched[0], ambiguous: false };
    }
    return { picker: null, ambiguous: true };
  };
  var BUBBLED_VARIANT_EVENTS = [
    "variant:change",
    "variant:update",
    "on:variant:update",
    "product:variant-change",
    "variantchange",
    "shopify:variant:change"
  ];
  PricingBlock.prototype.bindSectionScope = function() {
    var container = this.resolveSectionContainer();
    if (!container) return;
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
        this.horizonVariantObserver = new view.MutationObserver(function() {
          self.scheduleSectionMaintenance();
        });
        this.horizonVariantObserver.observe(container, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["value"]
        });
        var parent = container.parentNode;
        if (parent && parent.nodeType === 1) {
          this.sectionReplacementObserver = new view.MutationObserver(function() {
            self.handleSectionNodeReplacement();
          });
          this.sectionReplacementObserver.observe(parent, { childList: true });
        }
      }
      var onLifecycle = this.handleSectionLifecycleEvent.bind(this);
      doc.addEventListener("shopify:section:load", onLifecycle, { signal: master });
      doc.addEventListener("shopify:section:unload", onLifecycle, { signal: master });
    }
    this.bindRebindableSectionListeners();
  };
  PricingBlock.prototype.bindRebindableSectionListeners = function() {
    if (this.destroyed) return;
    var container = this.resolveSectionContainer();
    if (!container) return;
    if (this._sectionBindingController) this._sectionBindingController.abort();
    this._sectionBindingController = new AbortController();
    var signal = this._sectionBindingController.signal;
    var formInfo = this.resolveOwnedProductFormInput();
    var pickerInfo = this.resolveOwnedVariantPicker();
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
      targets[i].addEventListener("change", schedule, { signal });
      targets[i].addEventListener("input", schedule, { signal });
    }
  };
  PricingBlock.prototype.nativeContainmentRequired = function() {
    return this.pricingEnforcementIntended === true && this._enforcementState !== "bypass";
  };
  PricingBlock.prototype.updateEnforcementState = function(state) {
    if (this.destroyed) return;
    var next = state === "enforce" || state === "bypass" || state === "block" ? state : "block";
    if (next === this._enforcementState && next !== "bypass") {
      return;
    }
    this._enforcementState = next;
    if (next === "bypass") {
      this.releaseNativeCartContainment();
    } else {
      this.applyNativeCartContainment();
    }
  };
  PricingBlock.prototype.releaseNativeCartContainment = function() {
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
  PricingBlock.prototype.applyNativeCartContainment = function(signal) {
    if (this.destroyed) return;
    var sig = signal || this._sectionBindingController && this._sectionBindingController.signal || this.lifecycleController.signal;
    var container = this.resolveSectionContainer();
    if (!container || !this.nativeContainmentRequired()) return;
    var self = this;
    var ownerForms = [];
    var formNodes = container.querySelectorAll(
      'product-form form,form[action*="/cart/add"],form[data-type="add-to-cart-form"]'
    );
    for (var f = 0; f < formNodes.length; f++) {
      var fm = formNodes[f];
      if (self.root.contains(fm) || isExcludedFormContext(fm) || !self.inThisSection(fm)) continue;
      ownerForms.push(fm);
    }
    var controls = [];
    var addControl = function(el2) {
      if (!el2 || self.root.contains(el2) || isExcludedFormContext(el2) || !self.inThisSection(el2)) return;
      if (controls.indexOf(el2) === -1) controls.push(el2);
    };
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
    var stickies = container.querySelectorAll(STICKY_WRAPPER_SELECTOR);
    for (var s = 0; s < stickies.length; s++) {
      if (isExcludedFormContext(stickies[s]) || !self.inThisSection(stickies[s])) continue;
      var sc = stickies[s].querySelectorAll(NATIVE_SUBMIT_SELECTOR);
      for (var sci = 0; sci < sc.length; sci++) addControl(sc[sci]);
    }
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      if (el.getAttribute("data-imprintid-contained") !== "1") {
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
        }
        el.setAttribute("data-imprintid-contained", "1");
        el.setAttribute("aria-disabled", "true");
      }
      el.addEventListener("click", this._nativeControlClickGuard, { capture: true, signal: sig });
    }
    for (var w = 0; w < ownerForms.length; w++) {
      ownerForms[w].setAttribute("data-imprintid-contained-form", "1");
      ownerForms[w].addEventListener("submit", this._nativeFormSubmitGuard, { capture: true, signal: sig });
    }
    this.root.setAttribute("data-imprintid-native-contained", controls.length || ownerForms.length ? "true" : "false");
  };
  PricingBlock.prototype.inThisSection = function(el) {
    if (!this._sectionId) return true;
    var mine = "shopify-section-" + this._sectionId;
    var node = el;
    while (node && node.nodeType === 1) {
      var nodeId = node.getAttribute ? node.getAttribute("id") : null;
      if (nodeId === mine) return true;
      var marked = node.getAttribute ? node.getAttribute("data-section-id") : null;
      if (marked && node !== this.root) return marked === this._sectionId;
      if (nodeId && nodeId.indexOf("shopify-section-") === 0) return nodeId === mine;
      node = node.parentNode;
    }
    return true;
  };
  PricingBlock.prototype.handleContainedControlClick = function(event) {
    var el = event.currentTarget;
    if (el && el.getAttribute && el.getAttribute("data-imprintid-contained") === "1") {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      event.stopPropagation();
    }
  };
  PricingBlock.prototype.handleContainedFormSubmit = function(event) {
    var form = event.currentTarget;
    if (form && form.getAttribute && form.getAttribute("data-imprintid-contained-form") === "1") {
      event.preventDefault();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      event.stopPropagation();
    }
  };
  PricingBlock.prototype.scheduleSectionMaintenance = function() {
    if (this.destroyed || this._sectionMaintenanceScheduled) return;
    this._sectionMaintenanceScheduled = true;
    var self = this;
    var view = this.root.ownerDocument.defaultView || window;
    var run = function() {
      self._sectionMaintenanceScheduled = false;
      self.runSectionMaintenance();
    };
    if (typeof view.queueMicrotask === "function") view.queueMicrotask(run);
    else view.setTimeout(run, 0);
  };
  PricingBlock.prototype.runSectionMaintenance = function() {
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
  PricingBlock.prototype.handleSectionNodeReplacement = function() {
    if (this.destroyed) return;
    if (this.root.isConnected && this.resolveSectionContainer()) return;
    var doc = this.root.ownerDocument;
    var id = this._sectionId;
    this.destroy();
    if (!id) return;
    var scope = doc.getElementById("shopify-section-" + id) || (function() {
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
  PricingBlock.prototype.handleSectionLifecycleEvent = function(event) {
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
  PricingBlock.prototype.scheduleOwnedVariantReconcile = function() {
    if (this.destroyed) return;
    if (this._ownedReconcileScheduled) return;
    this._ownedReconcileScheduled = true;
    var self = this;
    var view = this.root.ownerDocument.defaultView || window;
    var run = function() {
      self._ownedReconcileScheduled = false;
      self.reconcileOwnedVariant();
    };
    if (typeof view.queueMicrotask === "function") view.queueMicrotask(run);
    else view.setTimeout(run, 0);
  };
  PricingBlock.prototype.reconcileOwnedVariant = function() {
    if (this.destroyed || !this.root.isConnected) return;
    if (!this.canUseDynamicPricing()) {
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
    if (!formInfo.input) return;
    var raw = formInfo.input.value;
    if (!isPositiveDigitString(raw)) return;
    if (raw === this._lastReconciledFormValue) return;
    this._lastReconciledFormValue = raw;
    if (raw === this.selectedVariantId) return;
    this.variantSelectionSequence++;
    this.resolveAndAdoptVariant(raw);
  };
  PricingBlock.prototype.bindVariantSelectListener = function() {
    var container = this.resolveSectionContainer();
    if (!container) {
      this.variantSelectListenTarget = null;
      console.warn(
        `[dynamic-pricing] Could not resolve this block's owning Shopify section (data-section-id="` + (this.root.dataset.sectionId || "") + '") — dynamic variant synchronization via ' + PRODUCT_SELECT_EVENT + " is unavailable for this block; it will keep using the variant selected at page render instead. No product, variant, or secret data is included in this message."
      );
      return;
    }
    this.variantSelectListenTarget = container;
    container.addEventListener(
      PRODUCT_SELECT_EVENT,
      this.handleProductSelect.bind(this),
      { signal: this.lifecycleController.signal }
    );
  };
  PricingBlock.prototype.handleProductSelect = function(event) {
    if (this.destroyed || !this.root.isConnected) {
      this.lifecycleController.abort();
      return;
    }
    if (!this.productGid) return;
    var eventProductId = event && event.product && event.product.id;
    if (eventProductId !== this.productGid) return;
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
      function(resolution) {
        self.onVariantSelectResolved(seq, selectSeq, resolution);
      },
      function() {
        self.handleVariantSyncFailure(seq, selectSeq);
      }
    );
  };
  PricingBlock.prototype.onVariantSelectResolved = function(seq, selectSeq, resolution) {
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
    if (!variant.availableForSale) {
      this.handleVariantUnavailable();
      return;
    }
    this.resolveAndAdoptVariant(numericId);
  };
  PricingBlock.prototype.resolveAndAdoptVariant = function(numericId) {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }
    this.invalidateSignedQuote();
    if (this.activeController) this.activeController.abort();
    var entry = resolveVariantFromMap(this.variantMap, numericId);
    if (!entry || !entry.available) {
      this.handleVariantUnavailable();
      return;
    }
    this.selectedVariantId = numericId;
    this.selectedVariantAvailable = entry.available;
    var skuChanged = entry.sku !== this.selectedVariantSku;
    this.selectedVariantSku = entry.sku;
    this.sku = entry.sku;
    this.clearError();
    if (!this.canUseDynamicPricing()) {
      this.handleVariantUnavailable();
      return;
    }
    if (skuChanged) {
      this.showLoading(true);
      this.fetchCatalog(true);
    } else {
      this.recalculateNow(true);
    }
  };
  PricingBlock.prototype.handleVariantUnavailable = function() {
    this.selectedVariantAvailable = false;
    this.invalidateSignedQuote();
    this.hideLoading();
    this.els.error.textContent = t(this.root, MESSAGES.variantUnavailable);
    this.els.error.hidden = false;
  };
  PricingBlock.prototype.handleVariantSyncFailure = function(seq, selectSeq) {
    if (seq !== void 0 && seq !== this.variantSelectionSequence) return;
    if (selectSeq !== void 0 && selectSeq !== this.productSelectSeq) return;
    this.selectedVariantAvailable = false;
    this.invalidateSignedQuote();
    this.hideLoading();
    this.els.error.textContent = t(this.root, MESSAGES.variantSyncError);
    this.els.error.hidden = false;
  };
  PricingBlock.prototype.crossCheckFormInput = function() {
    if (!this.formVariantInput) return false;
    var raw = this.formVariantInput.value;
    if (!isPositiveDigitString(raw)) return false;
    if (raw === this.selectedVariantId) return false;
    this.resolveAndAdoptVariant(raw);
    return true;
  };
  PricingBlock.prototype.addToCart = function() {
    if (!this.canUseDynamicPricing()) {
      this.failClosedForSync();
      return;
    }
    if (this.addToCartBusy) return;
    if (this.crossCheckFormInput()) {
      this.els.addToCartStatus.textContent = t(this.root, MESSAGES.variantChanged);
      return;
    }
    var self = this;
    var quantity = this.readQuantity();
    if (!quantity.valid) return;
    var mismatch = !this.cartPricing || this.shopifyProductId !== this.quotedProductId || this.selectedVariantId !== this.quotedVariantId || this.selectedVariantSku !== this.quotedVariantSku || this.quotedQuantity !== quantity.value || !this.selectedVariantAvailable;
    if (mismatch) {
      this.invalidateSignedQuote();
      this.els.addToCartStatus.textContent = t(this.root, MESSAGES.variantChanged);
      if (this.selectedVariantId && this.selectedVariantAvailable) this.recalculate();
      return;
    }
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
            properties: pricingProperties
          }
        ]
      })
    }).then(function(response) {
      return response.json().then(function(body) {
        return { ok: response.ok, body };
      });
    }).then(function(result) {
      self.addToCartBusy = false;
      self.els.addToCart.disabled = !self.cartPricing;
      if (result.ok) {
        self.els.addToCart.setAttribute("data-state", "success");
        self.els.addToCart.textContent = t(self.root, MESSAGES.addedToCart);
        self.els.addToCartStatus.textContent = "";
        window.setTimeout(function() {
          self.els.addToCart.removeAttribute("data-state");
          self.els.addToCart.textContent = t(self.root, MESSAGES.addToCart);
        }, 2200);
      } else {
        self.els.addToCart.setAttribute("data-state", "error");
        self.els.addToCart.textContent = t(self.root, MESSAGES.addToCart);
        self.els.addToCartStatus.textContent = t(self.root, MESSAGES.addToCartError);
      }
    }).catch(function() {
      self.addToCartBusy = false;
      self.els.addToCart.disabled = !self.cartPricing;
      self.els.addToCart.setAttribute("data-state", "error");
      self.els.addToCart.textContent = t(self.root, MESSAGES.addToCart);
      self.els.addToCartStatus.textContent = t(self.root, MESSAGES.addToCartError);
    });
  };
  PricingBlock.prototype.destroy = function() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._policyProbeSeq++;
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
    roots.forEach(function(root, index) {
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
  document.addEventListener("shopify:section:load", initAll);
  window.ImprintIdPricing = { PricingBlock };
})();
