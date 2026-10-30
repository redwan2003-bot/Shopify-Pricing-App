use crate::{config::CART_SIGNING_SECRET, schema};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use shopify_function::prelude::*;
use shopify_function::scalars::{Decimal, JsonValue};
use shopify_function::Result;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShopPolicy {
    schema: u8,
    mode: String,
    enabled: bool,
    adjustment_variant_gid: String,
    install_binding: String,
    policy_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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

/// Largest integer an `f64` represents exactly (2^53 - 1).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Shopify hands JSON numbers to the Function as `f64`. An integral value must reach serde as
/// an integer: `serde_json::Number::from_f64(11.0)` is a *float*, and deserializing a float into
/// an integer field (`schema: u8`, `policy_revision: u64`) fails with "invalid type: floating
/// point". That failure made `parse_json_policy` return `None` for every shop policy, so the
/// Transform returned no operations for every cart. This applies the same integral check the
/// `shopify_function_wasm_api` integer readers use, and keeps real fractions as floats.
fn number_to_serde(number: f64) -> Value {
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER {
        return if number >= 0.0 {
            Value::Number((number as u64).into())
        } else {
            Value::Number((number as i64).into())
        };
    }
    serde_json::Number::from_f64(number)
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

fn parse_json_policy<T: for<'a> Deserialize<'a>>(value: &JsonValue) -> Option<T> {
    serde_json::from_value(json_value_to_serde(value)).ok()
}

fn canonical_quote(quote: &Quote) -> String {
    [
        ("adjustmentVariantGid", quote.adjustment_variant_gid.clone()),
        (
            "baseUnitPriceCents",
            quote.base_unit_price_cents.to_string(),
        ),
        ("configDigest", quote.config_digest.clone()),
        ("currency", quote.currency.clone()),
        ("flatSurchargeCents", quote.flat_surcharge_cents.to_string()),
        ("installBinding", quote.install_binding.clone()),
        ("issuedAtServer", quote.issued_at_server.to_string()),
        ("lineTotalCents", quote.line_total_cents.to_string()),
        (
            "perUnitSurchargeCents",
            quote.per_unit_surcharge_cents.to_string(),
        ),
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

fn valid_signature(secret: &str, quote: &Quote, provided: &str) -> bool {
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(canonical_quote(quote).as_bytes());
    let Ok(provided) = hex::decode(provided) else {
        return false;
    };
    mac.verify_slice(&provided).is_ok()
}

fn cents(amount: u64) -> Decimal {
    Decimal((amount / 100) as f64 + (amount % 100) as f64 / 100.0)
}

fn cents_per_bundle(total_cents: u64, bundle_quantity: u64) -> Decimal {
    Decimal(total_cents as f64 / bundle_quantity as f64 / 100.0)
}

#[shopify_function]
fn cart_transform_run(
    input: schema::cart_transform_run::CartTransformRunInput,
) -> Result<schema::CartTransformRunResult> {
    run(input, CART_SIGNING_SECRET)
}

/// The Function body, with the signing secret passed in so tests can sign their own quotes.
fn run(
    input: schema::cart_transform_run::CartTransformRunInput,
    secret: &str,
) -> Result<schema::CartTransformRunResult> {
    let Some(policy_field) = input.shop().enforcement_policy() else {
        return Ok(schema::CartTransformRunResult { operations: vec![] });
    };
    let Some(policy) = parse_json_policy::<ShopPolicy>(policy_field.json_value()) else {
        return Ok(schema::CartTransformRunResult { operations: vec![] });
    };
    // `allowLegacyV1` only authorizes the legacy v1 branch below. It must not
    // disable valid v2 signed quotes; otherwise a pilot store carrying the
    // legacy compatibility flag silently leaves the original zero-priced line
    // untouched even though the server issued an enforceable v2 quote.
    if policy.schema != 1
        || !policy.enabled
        || !matches!(policy.mode.as_str(), "pilot" | "universal")
    {
        return Ok(schema::CartTransformRunResult { operations: vec![] });
    }
    if input.presentment_currency_rate().0 != 1.0 || secret.is_empty() {
        return Ok(schema::CartTransformRunResult { operations: vec![] });
    }

    let mut operations = Vec::new();
    for line in input.cart().lines() {
        let schema::cart_transform_run::cart_transform_run_input::cart::lines::Merchandise::ProductVariant(variant) = line.merchandise() else { continue; };
        let product = variant.product();
        // The signed v2 quote is the authoritative product-policy proof. The server
        // only issues it after reading the product policy, and the HMAC binds the
        // product, profile, profile revision, shop-policy revision, currency,
        // quantity, and line total. Re-reading the product metafield here created a
        // false negative on Shopify runtimes where app-owned product JSON is absent
        // from the Cart Transform input even though the cart line is valid.
        let Some(version) = line.version().and_then(|a| a.value()) else {
            continue;
        };
        let Some(raw_payload) = line.payload().and_then(|a| a.value()) else {
            continue;
        };
        let Some(signature) = line.signature().and_then(|a| a.value()) else {
            continue;
        };
        if version != "2" {
            continue;
        }
        let Ok(quote) = serde_json::from_str::<Quote>(raw_payload) else {
            continue;
        };
        let quantity = *line.quantity() as u64;
        if quote.v != 2
            || quote.install_binding != policy.install_binding
            || quote.adjustment_variant_gid != policy.adjustment_variant_gid
            || quote.policy_revision != policy.policy_revision
            || quote.product_gid != *product.id()
            || quote.variant_gid != *variant.id()
            || quote.quantity != quantity
        {
            continue;
        }
        let expected_total = quote
            .base_unit_price_cents
            .saturating_mul(quantity)
            .saturating_add(quote.per_unit_surcharge_cents.saturating_mul(quantity))
            .saturating_add(quote.flat_surcharge_cents);
        if expected_total != quote.line_total_cents || !valid_signature(secret, &quote, signature) {
            continue;
        }

        let price = |amount| schema::ExpandedItemPriceAdjustment {
            adjustment: schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(
                schema::ExpandedItemFixedPricePerUnitAdjustment {
                    amount: cents(amount),
                },
            ),
        };
        // Expanded quantities are per parent bundle unit; Shopify multiplies
        // each component quantity by the parent cart-line quantity.
        let mut expanded = vec![schema::ExpandedItem {
            merchandise_id: quote.variant_gid,
            quantity: 1,
            price: Some(price(quote.base_unit_price_cents)),
            attributes: None,
        }];
        let surcharge_total = quote
            .per_unit_surcharge_cents
            .saturating_mul(quantity)
            .saturating_add(quote.flat_surcharge_cents);
        if surcharge_total > 0 {
            expanded.push(schema::ExpandedItem {
                merchandise_id: quote.adjustment_variant_gid,
                quantity: 1,
                price: Some(schema::ExpandedItemPriceAdjustment {
                    adjustment: schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(
                        schema::ExpandedItemFixedPricePerUnitAdjustment {
                            amount: cents_per_bundle(surcharge_total, quantity),
                        },
                    ),
                }),
                attributes: None,
            });
        }
        operations.push(schema::Operation::LineExpand(schema::LineExpandOperation {
            cart_line_id: line.id().to_string(),
            expanded_cart_items: expanded,
            price: None,
            title: None,
            image: None,
        }));
    }
    Ok(schema::CartTransformRunResult { operations })
}

#[cfg(test)]
mod tests;
