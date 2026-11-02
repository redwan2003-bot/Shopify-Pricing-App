//! Cart & Checkout Validation Function — Rust port of `cart_validations_generate_run.ts`.
//!
//! WHY RUST: the TypeScript version (QuickJS under javy) spent ~27M instructions verifying one
//! HMAC-SHA256 signature, against Shopify's 11M-instruction limit per run. This port does the
//! same checks, in the same order, with the same reject codes and the same customer-facing
//! messages, in a fraction of that. The TypeScript file stays in the tree as the readable
//! reference (and its tests), exactly as `imprintid-cart-pricing` keeps `cart_transform_run.ts`.
//!
//! WHAT IT DOES (unchanged from the reference):
//!   * shop policy missing/malformed -> one global error for any ordinary product line;
//!   * a customer-added pricing-adjustment line is always rejected;
//!   * `disabled` -> everything else is allowed; `maintenance` -> every product line is blocked;
//!   * `pilot` / `universal`: every enforced line must carry a v2 quote that verifies
//!     (identity bindings, currency, config digest, monetary invariants, HMAC) AND whose signed
//!     line total equals the effective price Shopify shows after the Cart Transform ran;
//!   * cart interaction is allowed (the Transform expands the line first); checkout is checked.
//!
//! It never calculates a price and never uses a clock. An empty baked secret fails closed.

use crate::{config::CART_SIGNING_SECRET, schema};
use hmac::{Hmac, Mac};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use shopify_function::prelude::*;
use shopify_function::scalars::JsonValue;
use shopify_function::Result;

type HmacSha256 = Hmac<Sha256>;

const TARGET: &str = "$.cart";
const MAX_ERRORS: usize = 5;

const MSG_UNAVAILABLE: &str =
    "Dynamic pricing is temporarily unavailable. Please refresh the page or contact us.";
const MSG_STALE: &str = "This product’s pricing is no longer valid. Please return to the product page and configure it again.";
const MSG_DIRECT_ADJUSTMENT: &str = "This item can’t be added to the cart on its own.";
const MSG_SELLING_PLAN: &str =
    "This product can’t be purchased on a subscription. Please configure it as a one-time order.";

// Structural limits (mirror CART_PRICING_LIMITS in cart-pricing-contract.ts).
const MAX_PAYLOAD_BYTES: usize = 4096;
const MAX_CONFIG_BYTES: usize = 8192;
const MAX_CONFIG_DEPTH: usize = 8;
const MAX_CONFIG_KEYS: usize = 200;
const MAX_CONFIG_ARRAY_LENGTH: usize = 200;
const MAX_QUANTITY: u64 = 1_000_000;
const MAX_COMPONENT_CENTS: u64 = 100_000_000;
const MAX_LINE_TOTAL_CENTS: u64 = 10_000_000_000;
const MAX_POLICY_JSON_BYTES: usize = 2048;
const MAX_POLICY_STRING_LEN: usize = 256;
/// Largest integer an `f64` represents exactly (2^53 - 1).
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

// ---------------------------------------------------------------------------
// Normalized input (the plain shape all the logic works on)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InternalError {
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct QuoteAttrs {
    pub version: Option<String>,
    pub payload: Option<String>,
    pub signature: Option<String>,
    pub config: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Money {
    pub per_unit_cents: Option<u64>,
    pub subtotal_cents: Option<u64>,
    pub currency: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Line {
    pub id: String,
    pub quantity: i64,
    pub is_product_variant: bool,
    pub variant_gid: Option<String>,
    pub product_gid: Option<String>,
    pub product_policy: Option<Value>,
    pub has_selling_plan: bool,
    pub attrs: QuoteAttrs,
    pub money: Money,
    pub parent_line_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Input {
    pub buyer_step: Option<String>,
    pub shop_policy: Option<Value>,
    pub lines: Vec<Line>,
}

// ---------------------------------------------------------------------------
// JSON number handling
// ---------------------------------------------------------------------------

/// Shopify hands JSON numbers to a Function as `f64`; an integral value must reach serde as an
/// integer or it cannot fill an integer field (the bug that disabled the Cart Transform).
fn number_to_serde(number: f64) -> Value {
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER as f64 {
        return if number >= 0.0 {
            Value::Number((number as u64).into())
        } else {
            Value::Number((number as i64).into())
        };
    }
    Number::from_f64(number)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn json_value_to_serde(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::String(value) => Value::String(value.clone()),
        JsonValue::Number(value) => number_to_serde(*value),
        JsonValue::Boolean(value) => Value::Bool(*value),
        JsonValue::Object(value) => Value::Object(
            value
                .iter()
                .map(|(key, value)| (key.clone(), json_value_to_serde(value)))
                .collect(),
        ),
        JsonValue::Array(value) => Value::Array(value.iter().map(json_value_to_serde).collect()),
    }
}

/// A non-negative integer no larger than 2^53 - 1, accepting an integral float (`100.0`) the way
/// JavaScript's `Number.isInteger` does.
fn safe_u64(value: &Value) -> Option<u64> {
    let number = value.as_number()?;
    if let Some(u) = number.as_u64() {
        return (u <= MAX_SAFE_INTEGER).then_some(u);
    }
    if number.as_i64().is_some() {
        return None; // negative
    }
    let f = number.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f >= 0.0 && f <= MAX_SAFE_INTEGER as f64)
        .then_some(f as u64)
}

fn positive_safe_u64(value: &Value) -> Option<u64> {
    safe_u64(value).filter(|n| *n >= 1)
}

fn bounded_string(value: &Value) -> Option<&str> {
    let s = value.as_str()?;
    (!s.is_empty() && s.encode_utf16().count() <= MAX_POLICY_STRING_LEN).then_some(s)
}

fn within_size_budget(map: &Map<String, Value>) -> bool {
    serde_json::to_string(map)
        .map(|s| s.len() <= MAX_POLICY_JSON_BYTES)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct ShopPolicy {
    pub mode: String,
    pub enabled: bool,
    pub adjustment_variant_gid: String,
    pub install_binding: String,
    pub policy_revision: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct ProductPolicy {
    pub required: bool,
    pub profile_ref: String,
    pub profile_revision: u64,
    pub active: bool,
}

const SHOP_POLICY_KEYS: [&str; 7] = [
    "schema",
    "mode",
    "enabled",
    "allowLegacyV1",
    "adjustmentVariantGid",
    "installBinding",
    "policyRevision",
];
const PRODUCT_POLICY_KEYS: [&str; 6] = [
    "schema",
    "required",
    "profileRef",
    "profileRevision",
    "active",
    "policyRevision",
];
const MODES: [&str; 4] = ["disabled", "pilot", "universal", "maintenance"];

fn is_variant_gid(s: &str) -> bool {
    match s.strip_prefix("gid://shopify/ProductVariant/") {
        Some(id) => {
            !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && !id.starts_with('0')
        }
        None => false,
    }
}

pub(crate) fn parse_shop_policy(value: &Value) -> Option<ShopPolicy> {
    let map = value.as_object()?;
    if !within_size_budget(map) || !map.keys().all(|k| SHOP_POLICY_KEYS.contains(&k.as_str())) {
        return None;
    }
    if positive_safe_u64(map.get("schema")?)? != 1 {
        return None;
    }
    let mode = map.get("mode")?.as_str()?;
    if !MODES.contains(&mode) {
        return None;
    }
    let enabled = map.get("enabled")?.as_bool()?;
    if let Some(legacy) = map.get("allowLegacyV1") {
        legacy.as_bool()?; // present -> must be a real boolean
    }
    let adjustment = bounded_string(map.get("adjustmentVariantGid")?)?;
    if !is_variant_gid(adjustment) {
        return None;
    }
    let install_binding = bounded_string(map.get("installBinding")?)?;
    let policy_revision = positive_safe_u64(map.get("policyRevision")?)?;
    Some(ShopPolicy {
        mode: mode.to_string(),
        enabled,
        adjustment_variant_gid: adjustment.to_string(),
        install_binding: install_binding.to_string(),
        policy_revision,
    })
}

pub(crate) fn parse_product_policy(value: &Value) -> Option<ProductPolicy> {
    let map = value.as_object()?;
    if !within_size_budget(map)
        || !map
            .keys()
            .all(|k| PRODUCT_POLICY_KEYS.contains(&k.as_str()))
    {
        return None;
    }
    if positive_safe_u64(map.get("schema")?)? != 1 {
        return None;
    }
    let required = map.get("required")?.as_bool()?;
    let active = map.get("active")?.as_bool()?;
    let profile_ref = bounded_string(map.get("profileRef")?)?;
    let profile_revision = positive_safe_u64(map.get("profileRevision")?)?;
    positive_safe_u64(map.get("policyRevision")?)?;
    Some(ProductPolicy {
        required,
        profile_ref: profile_ref.to_string(),
        profile_revision,
        active,
    })
}

// ---------------------------------------------------------------------------
// The signed v2 quote
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct Quote {
    pub install_binding: String,
    pub product_gid: String,
    pub variant_gid: String,
    pub quantity: u64,
    pub currency: String,
    pub base_unit_price_cents: u64,
    pub per_unit_surcharge_cents: u64,
    pub flat_surcharge_cents: u64,
    pub line_total_cents: u64,
    pub adjustment_variant_gid: String,
    pub profile_ref: String,
    pub profile_revision: u64,
    pub policy_revision: u64,
    pub config_digest: String,
    pub quote_id: String,
    pub issued_at_server: u64,
}

const QUOTE_KEYS: [&str; 17] = [
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
    "issuedAtServer",
];

/// Strict parse: exactly the 17 known keys, each of the right type, `v` equal to 2.
pub(crate) fn parse_quote(raw: &str) -> Option<Quote> {
    if raw.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let value: Value = serde_json::from_str(raw).ok()?;
    let map = value.as_object()?;
    if map.len() != QUOTE_KEYS.len() || !QUOTE_KEYS.iter().all(|k| map.contains_key(*k)) {
        return None;
    }
    let text = |k: &str| {
        map.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let int = |k: &str| map.get(k).and_then(safe_u64);
    if int("v")? != 2 {
        return None;
    }
    let quantity = int("quantity")?;
    if quantity < 1 {
        return None;
    }
    Some(Quote {
        install_binding: text("installBinding")?,
        product_gid: text("productGid")?,
        variant_gid: text("variantGid")?,
        quantity,
        currency: text("currency")?,
        base_unit_price_cents: int("baseUnitPriceCents")?,
        per_unit_surcharge_cents: int("perUnitSurchargeCents")?,
        flat_surcharge_cents: int("flatSurchargeCents")?,
        line_total_cents: int("lineTotalCents")?,
        adjustment_variant_gid: text("adjustmentVariantGid")?,
        profile_ref: text("profileRef")?,
        profile_revision: int("profileRevision")?,
        policy_revision: int("policyRevision")?,
        config_digest: text("configDigest")?,
        quote_id: text("quoteId")?,
        issued_at_server: int("issuedAtServer")?,
    })
}

/// The exact text that is signed: every key sorted, `key=value`, joined by newlines.
pub(crate) fn canonical_quote(q: &Quote) -> String {
    [
        ("adjustmentVariantGid", q.adjustment_variant_gid.clone()),
        ("baseUnitPriceCents", q.base_unit_price_cents.to_string()),
        ("configDigest", q.config_digest.clone()),
        ("currency", q.currency.clone()),
        ("flatSurchargeCents", q.flat_surcharge_cents.to_string()),
        ("installBinding", q.install_binding.clone()),
        ("issuedAtServer", q.issued_at_server.to_string()),
        ("lineTotalCents", q.line_total_cents.to_string()),
        (
            "perUnitSurchargeCents",
            q.per_unit_surcharge_cents.to_string(),
        ),
        ("policyRevision", q.policy_revision.to_string()),
        ("productGid", q.product_gid.clone()),
        ("profileRef", q.profile_ref.clone()),
        ("profileRevision", q.profile_revision.to_string()),
        ("quantity", q.quantity.to_string()),
        ("quoteId", q.quote_id.clone()),
        ("v", "2".to_string()),
        ("variantGid", q.variant_gid.clone()),
    ]
    .into_iter()
    .map(|(key, value)| format!("{key}={value}"))
    .collect::<Vec<_>>()
    .join("\n")
}

pub(crate) fn sign_hex(secret: &str, message: &str) -> String {
    // An empty key is accepted by HMAC and computable by anyone, so it must never verify.
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn normalize_currency(value: &str) -> Option<String> {
    let upper = value.trim().to_uppercase();
    (upper.len() == 3 && upper.bytes().all(|b| b.is_ascii_uppercase())).then_some(upper)
}

// ---------------------------------------------------------------------------
// Config digest (the signed quote binds a digest of the cart line's config JSON)
// ---------------------------------------------------------------------------

fn normalize_config_value(value: &Value, depth: usize, keys: &mut usize) -> Option<Value> {
    if depth > MAX_CONFIG_DEPTH {
        return None;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Some(value.clone()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return (i.unsigned_abs() <= MAX_SAFE_INTEGER).then(|| Value::from(i));
            }
            if let Some(u) = n.as_u64() {
                return (u <= MAX_SAFE_INTEGER).then(|| Value::from(u));
            }
            let f = n.as_f64()?;
            if f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER as f64 {
                Some(if f >= 0.0 {
                    Value::from(f as u64)
                } else {
                    Value::from(f as i64)
                })
            } else {
                None
            }
        }
        Value::Array(items) => {
            if items.len() > MAX_CONFIG_ARRAY_LENGTH {
                return None;
            }
            items
                .iter()
                .map(|item| normalize_config_value(item, depth + 1, keys))
                .collect::<Option<Vec<_>>>()
                .map(Value::Array)
        }
        Value::Object(map) => {
            let mut out = Map::new(); // serde_json's Map is ordered by key
            for (key, child) in map {
                *keys += 1;
                if *keys > MAX_CONFIG_KEYS {
                    return None;
                }
                out.insert(key.clone(), normalize_config_value(child, depth + 1, keys)?);
            }
            Some(Value::Object(out))
        }
    }
}

/// `sha256:<hex>` of the canonical (sorted-key, integer-only) form of the config JSON, or `None`
/// when the config is oversized, malformed, or not representable.
pub(crate) fn config_digest(config: &str) -> Option<String> {
    if config.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let parsed: Value = serde_json::from_str(config).ok()?;
    let normalized = normalize_config_value(&parsed, 0, &mut 0)?;
    let canonical = serde_json::to_string(&normalized).ok()?;
    if canonical.len() > MAX_CONFIG_BYTES {
        return None;
    }
    Some(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    ))
}

// ---------------------------------------------------------------------------
// Full verification of one enforced line's quote
// ---------------------------------------------------------------------------

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|s| !s.is_empty())
}

fn check_monetary_invariants(q: &Quote) -> Option<&'static str> {
    if q.base_unit_price_cents > MAX_COMPONENT_CENTS
        || q.per_unit_surcharge_cents > MAX_COMPONENT_CENTS
        || q.flat_surcharge_cents > MAX_COMPONENT_CENTS
    {
        return Some("monetary_invariant");
    }
    if q.quantity < 1 || q.quantity > MAX_QUANTITY || q.line_total_cents > MAX_LINE_TOTAL_CENTS {
        return Some("monetary_invariant");
    }
    let computed = q.base_unit_price_cents * q.quantity
        + q.per_unit_surcharge_cents * q.quantity
        + q.flat_surcharge_cents;
    if computed > MAX_LINE_TOTAL_CENTS {
        return Some("monetary_invariant");
    }
    if computed != q.line_total_cents {
        return Some("line_total_mismatch");
    }
    None
}

/// Mirrors `verifyCartPricingAttributesV2`: cheap structural and identity checks first, the
/// HMAC last.
pub(crate) fn verify_quote(
    secret: &str,
    line: &Line,
    shop: &ShopPolicy,
    product: &ProductPolicy,
) -> std::result::Result<Quote, &'static str> {
    let attrs = &line.attrs;
    if non_empty(&attrs.version).is_none()
        || non_empty(&attrs.payload).is_none()
        || non_empty(&attrs.signature).is_none()
    {
        return Err("missing");
    }
    if attrs.version.as_deref() != Some("2") {
        return Err("unsupported_version");
    }
    if non_empty(&attrs.config).is_none() {
        return Err("missing");
    }
    let quote = parse_quote(attrs.payload.as_deref().unwrap_or_default()).ok_or("malformed")?;

    if quote.install_binding != shop.install_binding {
        return Err("install_mismatch");
    }
    if quote.adjustment_variant_gid != shop.adjustment_variant_gid {
        return Err("adjustment_mismatch");
    }
    if quote.policy_revision != shop.policy_revision {
        return Err("policy_revision_mismatch");
    }
    if quote.profile_ref != product.profile_ref {
        return Err("profile_ref_mismatch");
    }
    if quote.profile_revision != product.profile_revision {
        return Err("profile_revision_mismatch");
    }

    if line.variant_gid.as_deref() != Some(quote.variant_gid.as_str()) {
        return Err("variant_mismatch");
    }
    if line.product_gid.as_deref() != Some(quote.product_gid.as_str()) {
        return Err("product_mismatch");
    }
    if line.quantity < 0 || line.quantity as u64 != quote.quantity {
        return Err("quantity_mismatch");
    }

    let cart_currency = line.money.currency.as_deref().and_then(normalize_currency);
    let quote_currency = normalize_currency(&quote.currency);
    let (Some(cart_currency), Some(quote_currency)) = (cart_currency, quote_currency) else {
        return Err("currency_context_unavailable");
    };
    if cart_currency != quote_currency {
        return Err("currency_mismatch");
    }

    match attrs.config.as_deref().and_then(config_digest) {
        Some(digest) if digest == quote.config_digest => {}
        _ => return Err("config_digest_mismatch"),
    }

    if let Some(code) = check_monetary_invariants(&quote) {
        return Err(code);
    }

    if secret.is_empty() {
        return Err("bad_signature");
    }
    let expected = sign_hex(secret, &canonical_quote(&quote));
    if !constant_time_eq(attrs.signature.as_deref().unwrap_or_default(), &expected) {
        return Err("bad_signature");
    }
    Ok(quote)
}

fn validate_enforced_quote(
    line: &Line,
    shop: &ShopPolicy,
    product: &ProductPolicy,
    secret: &str,
) -> Option<&'static str> {
    if line.attrs.version.as_deref() != Some("2") {
        return Some("v1_rejected");
    }
    let a = &line.attrs;
    let well_formed = non_empty(&a.version).is_some()
        && non_empty(&a.payload).is_some()
        && non_empty(&a.signature).is_some()
        && non_empty(&a.config).is_some();
    if !well_formed
        || a.payload.as_deref().map_or(0, str::len) > MAX_PAYLOAD_BYTES
        || a.config.as_deref().map_or(0, str::len) > MAX_CONFIG_BYTES
    {
        return Some("quote_invalid");
    }
    verify_quote(secret, line, shop, product).err()
}

// ---------------------------------------------------------------------------
// Component integrity (for carts where Shopify exposes the expanded component lines)
// ---------------------------------------------------------------------------

struct Observed {
    merchandise_gid: String,
    quantity: i64,
    per_unit_cents: Option<u64>,
    currency: Option<String>,
}

fn check_component_integrity(parent: &Quote, observed: &[Observed]) -> bool {
    for c in observed {
        if c.quantity < 1 || c.quantity as u64 > MAX_QUANTITY {
            return true;
        }
        if c.per_unit_cents.is_none() {
            return true;
        }
        if let Some(currency) = &c.currency {
            if *currency != parent.currency {
                return true;
            }
        }
    }
    // expected components: the base, plus one surcharge component when the surcharge total > 0.
    // A surcharge that does not divide evenly across the quantity can never match an observed
    // whole-cent amount, so it is represented as `None` (always a mismatch), as in the reference.
    let mut expected: Vec<(String, i64, Option<u64>)> = vec![(
        parent.variant_gid.clone(),
        1,
        Some(parent.base_unit_price_cents),
    )];
    let surcharge_total =
        parent.per_unit_surcharge_cents * parent.quantity + parent.flat_surcharge_cents;
    if surcharge_total > 0 {
        let per_unit =
            (surcharge_total % parent.quantity == 0).then(|| surcharge_total / parent.quantity);
        expected.push((parent.adjustment_variant_gid.clone(), 1, per_unit));
    }
    if observed.len() != expected.len() {
        return true;
    }
    let mut observed_keys: Vec<(String, i64, Option<u64>)> = observed
        .iter()
        .map(|c| (c.merchandise_gid.clone(), c.quantity, c.per_unit_cents))
        .collect();
    expected.sort();
    observed_keys.sort();
    expected != observed_keys
}

// ---------------------------------------------------------------------------
// The validation run
// ---------------------------------------------------------------------------

struct Errors(Vec<InternalError>);

impl Errors {
    fn push(&mut self, code: &'static str, message: &'static str) {
        if self.0.len() < MAX_ERRORS
            && !self
                .0
                .iter()
                .any(|e| e.code == code && e.message == message)
        {
            self.0.push(InternalError { code, message });
        }
    }
    fn finalize(mut self) -> Vec<InternalError> {
        self.0.sort_by(|a, b| a.code.cmp(b.code));
        self.0.truncate(MAX_ERRORS);
        self.0
    }
}

fn is_adjustment(line: &Line, policy: &ShopPolicy) -> bool {
    line.variant_gid
        .as_deref()
        .is_some_and(|v| v == policy.adjustment_variant_gid)
}

/// Whether a line is subject to pilot/universal enforcement. Emits its own policy error for a
/// present-but-malformed or inactive policy on an intended enforced product.
fn determine_enforced(mode: &str, line: &Line, errors: &mut Errors) -> Option<ProductPolicy> {
    let present = !matches!(line.product_policy, None | Some(Value::Null));
    let parsed = line.product_policy.as_ref().and_then(parse_product_policy);

    if mode == "universal" {
        return match parsed {
            Some(p) if p.active => Some(p),
            Some(_) => {
                errors.push("product_policy_inactive", MSG_STALE);
                None
            }
            None => {
                errors.push("product_policy_missing_or_malformed", MSG_STALE);
                None
            }
        };
    }
    // pilot
    if !present {
        return None;
    }
    let Some(p) = parsed else {
        errors.push("product_policy_missing_or_malformed", MSG_STALE);
        return None;
    };
    if !p.active {
        errors.push("product_policy_inactive", MSG_STALE);
        return None;
    }
    p.required.then_some(p)
}

fn observed_components(components: &[&Line], parent_id: &str) -> Vec<Observed> {
    components
        .iter()
        .filter(|c| c.parent_line_id.as_deref() == Some(parent_id))
        .map(|c| Observed {
            merchandise_gid: c.variant_gid.clone().unwrap_or_default(),
            quantity: c.quantity,
            per_unit_cents: c.money.per_unit_cents,
            currency: c.money.currency.clone(),
        })
        .collect()
}

pub(crate) fn run_validation(input: &Input, secret: &str) -> Vec<InternalError> {
    let mut errors = Errors(Vec::new());
    let top_level: Vec<&Line> = input
        .lines
        .iter()
        .filter(|l| l.parent_line_id.is_none())
        .collect();
    let components: Vec<&Line> = input
        .lines
        .iter()
        .filter(|l| l.parent_line_id.is_some())
        .collect();
    let has_ordinary_variant = top_level.iter().any(|l| l.is_product_variant);

    // A. missing / malformed shop policy -> one global error (never a legacy fallback).
    let Some(policy) = input.shop_policy.as_ref().and_then(parse_shop_policy) else {
        if has_ordinary_variant {
            errors.push("shop_policy_missing_or_malformed", MSG_UNAVAILABLE);
        }
        return errors.finalize();
    };

    // Direct-adjustment protection applies in every mode.
    for line in &top_level {
        if is_adjustment(line, &policy) {
            errors.push("direct_adjustment", MSG_DIRECT_ADJUSTMENT);
        }
    }

    // F. the kill switch: a disabled policy behaves as `disabled`.
    let mode = if policy.enabled {
        policy.mode.as_str()
    } else {
        "disabled"
    };
    if mode == "disabled" {
        return errors.finalize();
    }
    // E. maintenance -> block every ordinary product line, no native fallback.
    if mode == "maintenance" {
        if has_ordinary_variant {
            errors.push("maintenance_block", MSG_UNAVAILABLE);
        }
        return errors.finalize();
    }

    // C. pilot / D. universal. Cart interaction is allowed: the Transform authenticates and
    // expands the line before the cart renders, and checkout is where the price is verified.
    if input.buyer_step.as_deref() == Some("CART_INTERACTION") {
        return errors.finalize();
    }

    for line in &top_level {
        if !line.is_product_variant || is_adjustment(line, &policy) {
            continue;
        }
        let Some(product_policy) = determine_enforced(mode, line, &mut errors) else {
            continue;
        };

        if line.has_selling_plan {
            errors.push("selling_plan_unsupported", MSG_SELLING_PLAN);
            continue;
        }
        if let Some(code) = validate_enforced_quote(line, &policy, &product_policy, secret) {
            errors.push(code, MSG_STALE);
            continue;
        }
        let Some(quote) = line.attrs.payload.as_deref().and_then(parse_quote) else {
            errors.push("quote_invalid", MSG_STALE);
            continue;
        };
        let observed = observed_components(&components, &line.id);
        if !observed.is_empty() {
            if check_component_integrity(&quote, &observed) {
                errors.push("component_forgery", MSG_STALE);
            }
        } else if line
            .money
            .subtotal_cents
            .is_some_and(|subtotal| subtotal != quote.line_total_cents)
        {
            // Shopify shows an expanded line as one line at its effective price. It must equal the
            // signed total: an unexpanded ($0.00) or altered line is never allowed through.
            errors.push("effective_price_mismatch", MSG_STALE);
        }
    }

    // Component lines authenticate via their COMPLETE resolved parent; no permissive fallback.
    let mut checked_parents: Vec<&str> = Vec::new();
    for child in &components {
        let parent_id = child.parent_line_id.as_deref().unwrap_or_default();
        let parent = input
            .lines
            .iter()
            .find(|l| l.id == parent_id && l.parent_line_id.is_none() && l.is_product_variant);
        let Some(parent) = parent else {
            errors.push("orphan_component", MSG_STALE);
            continue;
        };
        let Some(parent_policy) = parent
            .product_policy
            .as_ref()
            .and_then(parse_product_policy)
            .filter(|p| p.active)
        else {
            errors.push("orphan_component", MSG_STALE);
            continue;
        };
        if validate_enforced_quote(parent, &policy, &parent_policy, secret).is_some() {
            errors.push("orphan_component", MSG_STALE);
            continue;
        }
        let Some(parent_quote) = parent.attrs.payload.as_deref().and_then(parse_quote) else {
            errors.push("orphan_component", MSG_STALE);
            continue;
        };
        if is_adjustment(child, &policy)
            && child.variant_gid.as_deref() != Some(parent_quote.adjustment_variant_gid.as_str())
        {
            errors.push("component_forgery", MSG_STALE);
            continue;
        }
        if !checked_parents.contains(&parent.id.as_str()) {
            checked_parents.push(parent.id.as_str());
            if check_component_integrity(
                &parent_quote,
                &observed_components(&components, &parent.id),
            ) {
                errors.push("component_forgery", MSG_STALE);
            }
        }
    }

    errors.finalize()
}

// ---------------------------------------------------------------------------
// Shopify input -> normalized input
// ---------------------------------------------------------------------------

/// A decimal money amount as whole cents. Shopify gives the amount as a decimal; it must be a
/// non-negative value with at most two decimal places.
fn amount_to_cents(amount: f64) -> Option<u64> {
    if !amount.is_finite() || amount < 0.0 || amount >= 1.0e12 {
        return None;
    }
    let cents = (amount * 100.0).round();
    ((amount * 100.0 - cents).abs() < 1.0e-6).then_some(cents as u64)
}

/// The name of a generated enum variant or code scalar (e.g. `CheckoutInteraction`, `"USD"`),
/// looking through the `Some(..)` wrapper of an optional field and the quotes of a string scalar.
fn variant_name(value: &impl std::fmt::Debug) -> String {
    let text = format!("{value:?}");
    text.strip_prefix("Some(")
        .and_then(|rest| rest.strip_suffix(')'))
        .unwrap_or(&text)
        .trim_matches('"')
        .to_string()
}

fn normalize(
    input: &schema::cart_validations_generate_run::CartValidationsGenerateRunInput,
) -> Input {
    use schema::cart_validations_generate_run::cart_validations_generate_run_input::cart::lines::Merchandise;
    let lines = input
        .cart()
        .lines()
        .iter()
        .map(|line| {
            let (is_variant, variant_gid, product_gid, product_policy) = match line.merchandise() {
                Merchandise::ProductVariant(variant) => {
                    let product = variant.product();
                    let policy = product
                        .pricing_policy()
                        .map(|m| json_value_to_serde(m.json_value()));
                    (
                        true,
                        Some(variant.id().to_string()),
                        Some(product.id().to_string()),
                        policy,
                    )
                }
                _ => (false, None, None, None),
            };
            Line {
                id: line.id().to_string(),
                quantity: i64::from(*line.quantity()),
                is_product_variant: is_variant,
                variant_gid,
                product_gid,
                product_policy,
                has_selling_plan: line.selling_plan_allocation().is_some(),
                attrs: QuoteAttrs {
                    version: line.version().and_then(|a| a.value().cloned()),
                    payload: line.payload().and_then(|a| a.value().cloned()),
                    signature: line.signature().and_then(|a| a.value().cloned()),
                    config: line.config().and_then(|a| a.value().cloned()),
                },
                money: Money {
                    per_unit_cents: amount_to_cents(line.cost().amount_per_quantity().amount().0),
                    subtotal_cents: amount_to_cents(line.cost().subtotal_amount().amount().0),
                    currency: Some(
                        variant_name(line.cost().subtotal_amount().currency_code()).to_uppercase(),
                    ),
                },
                parent_line_id: line
                    .parent_relationship()
                    .map(|p| p.parent().id().to_string()),
            }
        })
        .collect();
    Input {
        buyer_step: Some(match variant_name(&input.buyer_journey().step()).as_str() {
            "CartInteraction" => "CART_INTERACTION".to_string(),
            "CheckoutInteraction" => "CHECKOUT_INTERACTION".to_string(),
            "CheckoutCompletion" => "CHECKOUT_COMPLETION".to_string(),
            other => other.to_string(),
        }),
        shop_policy: input
            .shop()
            .enforcement_policy()
            .map(|m| json_value_to_serde(m.json_value())),
        lines,
    }
}

#[shopify_function]
fn cart_validations_generate_run(
    input: schema::cart_validations_generate_run::CartValidationsGenerateRunInput,
) -> Result<schema::CartValidationsGenerateRunResult> {
    run(input, CART_SIGNING_SECRET)
}

/// The Function body, with the signing secret passed in so tests can sign their own quotes.
pub(crate) fn run(
    input: schema::cart_validations_generate_run::CartValidationsGenerateRunInput,
    secret: &str,
) -> Result<schema::CartValidationsGenerateRunResult> {
    let errors = run_validation(&normalize(&input), secret)
        .into_iter()
        .map(|e| schema::ValidationError {
            message: e.message.to_string(),
            target: TARGET.to_string(),
        })
        .collect();
    Ok(schema::CartValidationsGenerateRunResult {
        operations: vec![schema::Operation::ValidationAdd(
            schema::ValidationAddOperation { errors },
        )],
    })
}

#[cfg(test)]
mod tests;
