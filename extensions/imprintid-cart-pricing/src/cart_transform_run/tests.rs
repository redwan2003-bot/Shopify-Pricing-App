use super::*;
use serde_json::json;
use shopify_function::run_function_with_input;
use std::collections::BTreeMap;

/// A throwaway secret: the tests sign their own quotes, so no real secret is ever needed.
const TEST_SECRET: &str = "unit-test-signing-secret-not-a-real-one";
/// The real logged LNY01 cart (quantity 100): one current quote plus two stale lines that were
/// left in the browser cart. See tests/fixtures/lny01-cart-input.json.
const FIXTURE: &str = include_str!("../../tests/fixtures/lny01-cart-input.json");

const LNY01_VARIANT: &str = "gid://shopify/ProductVariant/49375196872843";
const ADJUSTMENT_VARIANT: &str = "gid://shopify/ProductVariant/50668934103179";

fn is_current_quote(line: &Value) -> bool {
    let payload: Value = serde_json::from_str(line["payload"]["value"].as_str().unwrap()).unwrap();
    payload["policyRevision"] == 11
}

/// The fixture with the current quote re-signed under `secret`. The stale lines keep their
/// original (now meaningless) signatures.
fn input_json(secret: &str) -> Value {
    let mut input: Value = serde_json::from_str(FIXTURE).unwrap();
    for line in input["cart"]["lines"].as_array_mut().unwrap() {
        if !is_current_quote(line) {
            continue;
        }
        let quote: Quote =
            serde_json::from_str(line["payload"]["value"].as_str().unwrap()).unwrap();
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(canonical_quote(&quote).as_bytes());
        line["signature"]["value"] = Value::String(hex::encode(mac.finalize().into_bytes()));
    }
    input
}

fn run_json(input: &Value, secret: &str) -> schema::CartTransformRunResult {
    run_function_with_input(|i| run(i, secret), &input.to_string()).expect("the Function ran")
}

fn cents_of(item: &schema::ExpandedItem) -> u64 {
    // `FixedPricePerUnit` is the schema's only adjustment kind, so this pattern is irrefutable;
    // a new kind would stop this compiling and force the test to be revisited.
    let schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(a) =
        &item.price.as_ref().expect("a price adjustment").adjustment;
    (a.amount.0 * 100.0).round() as u64
}

fn host_policy(schema_number: f64, revision: f64) -> JsonValue {
    JsonValue::Object(BTreeMap::from([
        ("schema".to_string(), JsonValue::Number(schema_number)),
        ("mode".to_string(), JsonValue::String("pilot".into())),
        ("enabled".to_string(), JsonValue::Boolean(true)),
        (
            "adjustmentVariantGid".to_string(),
            JsonValue::String(ADJUSTMENT_VARIANT.into()),
        ),
        (
            "installBinding".to_string(),
            JsonValue::String("dev-imprintid-pricing-development-pilot-1".into()),
        ),
        ("policyRevision".to_string(), JsonValue::Number(revision)),
    ]))
}

#[test]
fn the_real_policy_shape_parses_when_the_host_hands_numbers_over_as_f64() {
    // Shopify exposes every JSON number as an f64: `schema: 1` arrives as 1.0 and
    // `policyRevision: 11` as 11.0. Before the fix this returned None for every policy.
    let policy =
        parse_json_policy::<ShopPolicy>(&host_policy(1.0, 11.0)).expect("the policy parses");
    assert_eq!(policy.schema, 1);
    assert_eq!(policy.policy_revision, 11);
    assert!(policy.enabled);
    assert_eq!(policy.mode, "pilot");
    assert_eq!(policy.adjustment_variant_gid, ADJUSTMENT_VARIANT);
}

#[test]
fn a_float_number_cannot_fill_an_integer_field_which_is_why_the_conversion_exists() {
    // Pins the root cause: the old conversion produced exactly this value.
    let mut policy = json!({
        "schema": 1, "mode": "pilot", "enabled": true,
        "adjustmentVariantGid": ADJUSTMENT_VARIANT, "installBinding": "x", "policyRevision": 11
    });
    policy["policyRevision"] = Value::Number(serde_json::Number::from_f64(11.0).unwrap());
    assert!(serde_json::from_value::<ShopPolicy>(policy).is_err());
}

#[test]
fn integral_numbers_stay_integers_and_fractions_stay_floats() {
    assert!(number_to_serde(11.0).is_u64());
    assert!(number_to_serde(0.0).is_u64());
    assert!(number_to_serde(-0.0).is_u64());
    assert!(number_to_serde(-3.0).is_i64());
    assert!(number_to_serde(1.5).is_f64());
    // beyond 2^53 an f64 no longer represents every integer, so it is not promoted
    assert!(number_to_serde(9_007_199_254_740_992.0).is_f64());
    assert_eq!(number_to_serde(f64::NAN), Value::Null);
    assert_eq!(number_to_serde(f64::INFINITY), Value::Null);
}

#[test]
fn the_logged_lny01_cart_expands_the_current_quote_into_exactly_one_line_expand() {
    let input = input_json(TEST_SECRET);
    let current = input["cart"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| is_current_quote(l))
        .unwrap()
        .clone();
    let quote: Quote = serde_json::from_str(current["payload"]["value"].as_str().unwrap()).unwrap();

    let result = run_json(&input, TEST_SECRET);
    assert_eq!(
        result.operations.len(),
        1,
        "stale lines add nothing, the current quote adds one"
    );
    let schema::Operation::LineExpand(op) = &result.operations[0] else {
        panic!("expected a lineExpand")
    };
    assert_eq!(op.cart_line_id, current["id"].as_str().unwrap());
    assert_eq!(op.expanded_cart_items.len(), 2);

    let (base, setup) = (&op.expanded_cart_items[0], &op.expanded_cart_items[1]);
    assert_eq!(base.merchandise_id, LNY01_VARIANT);
    assert_eq!(setup.merchandise_id, ADJUSTMENT_VARIANT);
    assert_eq!((base.quantity, setup.quantity), (1, 1));

    // Per cart-line unit: $1.37 for the product and $0.36 for the one-time $36.00 setup
    // charge spread over the 100 units. Shopify multiplies by the line quantity (100).
    assert_eq!((cents_of(base), cents_of(setup)), (137, 36));
    let line_total_cents = (cents_of(base) + cents_of(setup)) * quote.quantity;
    assert_eq!(line_total_cents, quote.line_total_cents);
    assert_eq!(
        line_total_cents, 17_300,
        "$137.00 product + $36.00 SCREEN_PRINT 1-colour 1-location setup"
    );
    assert_eq!(
        cents_of(base) * quote.quantity,
        13_700,
        "the undecorated product total is $137.00"
    );
    assert_eq!(quote.flat_surcharge_cents, 3_600);
}

#[test]
fn stale_quotes_alone_produce_no_operation() {
    let mut input = input_json(TEST_SECRET);
    input["cart"]["lines"]
        .as_array_mut()
        .unwrap()
        .retain(|l| !is_current_quote(l));
    assert_eq!(input["cart"]["lines"].as_array().unwrap().len(), 2);
    assert!(run_json(&input, TEST_SECRET).operations.is_empty());
}

#[test]
fn a_wrong_secret_or_tampered_signature_produces_no_operation() {
    assert!(run_json(&input_json("some-other-secret"), TEST_SECRET)
        .operations
        .is_empty());

    let mut input = input_json(TEST_SECRET);
    for line in input["cart"]["lines"].as_array_mut().unwrap() {
        if is_current_quote(line) {
            let sig = line["signature"]["value"].as_str().unwrap().to_string();
            let flipped = if sig.starts_with('0') {
                format!("1{}", &sig[1..])
            } else {
                format!("0{}", &sig[1..])
            };
            line["signature"]["value"] = Value::String(flipped);
        }
    }
    assert!(run_json(&input, TEST_SECRET).operations.is_empty());
}

#[test]
fn a_disabled_policy_a_non_par_rate_or_an_empty_secret_produces_no_operation() {
    let mut off = input_json(TEST_SECRET);
    off["shop"]["enforcementPolicy"]["jsonValue"]["enabled"] = json!(false);
    assert!(run_json(&off, TEST_SECRET).operations.is_empty());

    let mut disabled_mode = input_json(TEST_SECRET);
    disabled_mode["shop"]["enforcementPolicy"]["jsonValue"]["mode"] = json!("disabled");
    assert!(run_json(&disabled_mode, TEST_SECRET).operations.is_empty());

    let mut rate = input_json(TEST_SECRET);
    rate["presentmentCurrencyRate"] = json!("1.5");
    assert!(run_json(&rate, TEST_SECRET).operations.is_empty());

    assert!(
        run_json(&input_json(""), "").operations.is_empty(),
        "a fail-closed empty secret never expands"
    );
}

#[test]
fn a_bumped_shop_policy_revision_invalidates_the_quote() {
    let mut input = input_json(TEST_SECRET);
    input["shop"]["enforcementPolicy"]["jsonValue"]["policyRevision"] = json!(12);
    assert!(run_json(&input, TEST_SECRET).operations.is_empty());
}
