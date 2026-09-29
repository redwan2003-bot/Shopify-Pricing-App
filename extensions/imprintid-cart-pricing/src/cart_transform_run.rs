use crate::{config::CART_SIGNING_SECRET, schema};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use shopify_function::prelude::*;
use shopify_function::scalars::{Decimal, JsonValue};
use shopify_function::Result;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShopPolicy {
    schema: u8,
    mode: String,
    enabled: bool,
    #[serde(default)]
    allow_legacy_v1: bool,
    adjustment_variant_gid: String,
    install_binding: String,
    policy_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductPolicy {
    schema: u8,
    required: bool,
    profile_ref: String,
    profile_revision: u64,
    active: bool,
    policy_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Quote {
    v: u8,
    install_binding: String,
    product_gid: String,
    variant_gid: String,
    quantity: u64,
    currency: String,
    base_unit_price_cents: u64,
    per_unit_surcharge_cents: u64,
    flat_surcharge_cents: u64,
    line_total_cents: u64,
    adjustment_variant_gid: String,
    profile_ref: String,
    profile_revision: u64,
    policy_revision: u64,
    config_digest: String,
    quote_id: String,
    issued_at_server: u64,
}

fn sha256_hex(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut ordered = std::collections::BTreeMap::new();
            for (key, value) in object { ordered.insert(key.clone(), canonicalize_json(value)); }
            Value::Object(ordered.into_iter().collect::<Map<String, Value>>())
        }
        Value::Array(values) => Value::Array(values.iter().map(canonicalize_json).collect()),
        _ => value.clone(),
    }
}

fn normalized_config_digest(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let canonical = serde_json::to_string(&canonicalize_json(&value)).ok()?;
    Some(sha256_hex(&canonical))
}

fn json_value_to_serde(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::String(value) => Value::String(value.clone()),
        JsonValue::Number(value) => serde_json::Number::from_f64(*value).map(Value::Number).unwrap_or(Value::Null),
        JsonValue::Boolean(value) => Value::Bool(*value),
        JsonValue::Object(value) => Value::Object(value.iter().map(|(key, value)| (key.clone(), json_value_to_serde(value))).collect()),
        JsonValue::Array(value) => Value::Array(value.iter().map(json_value_to_serde).collect()),
    }
}

fn parse_json_policy<T: for<'a> Deserialize<'a>>(value: &JsonValue) -> Option<T> {
    serde_json::from_value(json_value_to_serde(value)).ok()
}

fn canonical_quote(quote: &Quote) -> String {
    [
        ("adjustmentVariantGid", quote.adjustment_variant_gid.clone()),
        ("baseUnitPriceCents", quote.base_unit_price_cents.to_string()),
        ("configDigest", quote.config_digest.clone()),
        ("currency", quote.currency.clone()),
        ("flatSurchargeCents", quote.flat_surcharge_cents.to_string()),
        ("installBinding", quote.install_binding.clone()),
        ("issuedAtServer", quote.issued_at_server.to_string()),
        ("lineTotalCents", quote.line_total_cents.to_string()),
        ("perUnitSurchargeCents", quote.per_unit_surcharge_cents.to_string()),
        ("policyRevision", quote.policy_revision.to_string()),
        ("productGid", quote.product_gid.clone()),
        ("profileRef", quote.profile_ref.clone()),
        ("profileRevision", quote.profile_revision.to_string()),
        ("quantity", quote.quantity.to_string()),
        ("quoteId", quote.quote_id.clone()),
        ("v", quote.v.to_string()),
        ("variantGid", quote.variant_gid.clone()),
    ]
    .into_iter()
    .map(|(key, value)| format!("{key}={value}"))
    .collect::<Vec<_>>()
    .join("\n")
}

fn valid_signature(quote: &Quote, provided: &str) -> bool {
    let Ok(mut mac) = HmacSha256::new_from_slice(CART_SIGNING_SECRET.as_bytes()) else { return false; };
    mac.update(canonical_quote(quote).as_bytes());
    let Ok(provided) = hex::decode(provided) else { return false; };
    mac.verify_slice(&provided).is_ok()
}

fn cents(amount: u64) -> Decimal { Decimal((amount / 100) as f64 + (amount % 100) as f64 / 100.0) }

#[shopify_function]
fn cart_transform_run(input: schema::cart_transform_run::CartTransformRunInput) -> Result<schema::CartTransformRunResult> {
    let Some(policy_field) = input.shop().enforcement_policy() else { return Ok(schema::CartTransformRunResult { operations: vec![] }); };
    let Some(policy) = parse_json_policy::<ShopPolicy>(policy_field.json_value()) else { return Ok(schema::CartTransformRunResult { operations: vec![] }); };
    if policy.schema != 1 || !policy.enabled || !matches!(policy.mode.as_str(), "pilot" | "universal") || policy.allow_legacy_v1 {
        return Ok(schema::CartTransformRunResult { operations: vec![] });
    }
    if input.presentment_currency_rate().0 != 1.0 || CART_SIGNING_SECRET.is_empty() {
        return Ok(schema::CartTransformRunResult { operations: vec![] });
    }

    let mut operations = Vec::new();
    for line in input.cart().lines() {
        let schema::cart_transform_run::cart_transform_run_input::cart::lines::Merchandise::ProductVariant(variant) = line.merchandise() else { continue; };
        let product = variant.product();
        let Some(product_policy_field) = product.pricing_policy() else { continue; };
        let Some(product_policy) = parse_json_policy::<ProductPolicy>(product_policy_field.json_value()) else { continue; };
        if product_policy.schema != 1 || !product_policy.active || !product_policy.required { continue; }
        let Some(version) = line.version().and_then(|a| a.value()) else { continue; };
        let Some(raw_payload) = line.payload().and_then(|a| a.value()) else { continue; };
        let Some(signature) = line.signature().and_then(|a| a.value()) else { continue; };
        let Some(config) = line.config().and_then(|a| a.value()) else { continue; };
        if version != "2" { continue; }
        let Ok(quote) = serde_json::from_str::<Quote>(raw_payload) else { continue; };
        let quantity = *line.quantity() as u64;
        if quote.v != 2 || quote.install_binding != policy.install_binding || quote.adjustment_variant_gid != policy.adjustment_variant_gid || quote.policy_revision != policy.policy_revision || quote.product_gid != *product.id() || quote.variant_gid != *variant.id() || quote.quantity != quantity || quote.profile_ref != product_policy.profile_ref || quote.profile_revision != product_policy.profile_revision || normalized_config_digest(config).as_deref() != Some(quote.config_digest.as_str()) || quote.currency != line.cost().amount_per_quantity().currency_code().to_string() { continue; }
        let expected_total = quote.base_unit_price_cents.saturating_mul(quantity).saturating_add(quote.per_unit_surcharge_cents.saturating_mul(quantity)).saturating_add(quote.flat_surcharge_cents);
        if expected_total != quote.line_total_cents || !valid_signature(&quote, signature) { continue; }

        let price = |amount| schema::ExpandedItemPriceAdjustment { adjustment: schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(schema::ExpandedItemFixedPricePerUnitAdjustment { amount: cents(amount) }) };
        let mut expanded = vec![schema::ExpandedItem { merchandise_id: quote.variant_gid, quantity: *line.quantity(), price: Some(price(quote.base_unit_price_cents)), attributes: None }];
        if quote.per_unit_surcharge_cents > 0 { expanded.push(schema::ExpandedItem { merchandise_id: quote.adjustment_variant_gid.clone(), quantity: *line.quantity(), price: Some(price(quote.per_unit_surcharge_cents)), attributes: None }); }
        if quote.flat_surcharge_cents > 0 { expanded.push(schema::ExpandedItem { merchandise_id: quote.adjustment_variant_gid, quantity: 1, price: Some(price(quote.flat_surcharge_cents)), attributes: None }); }
        operations.push(schema::Operation::LineExpand(schema::LineExpandOperation { cart_line_id: line.id().to_string(), expanded_cart_items: expanded, price: None, title: None, image: None }));
    }
    Ok(schema::CartTransformRunResult { operations })
}
