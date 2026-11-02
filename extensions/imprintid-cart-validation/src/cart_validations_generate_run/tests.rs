use super::*;
use serde_json::json;
use shopify_function::run_function_with_input;

/// A throwaway secret: the tests sign their own quotes, so no real secret is ever needed.
const TEST_SECRET: &str = "validation-test-secret-not-a-real-one";
/// The real validation input Shopify gave this Function at checkout on 2026-11-02 for LNY01,
/// quantity 100, default screen print, after the Cart Transform expanded the line: ONE top-level
/// line, no components, `amountPerQuantity` 1.73 and `subtotalAmount` 173.0. Its signature was made
/// with the production secret, so `capture()` re-signs the quote under `TEST_SECRET`.
const FIXTURE: &str = include_str!("../fixtures/lny01-checkout-input.json");

const LNY01_VARIANT: &str = "gid://shopify/ProductVariant/49375196872843";
const ADJUSTMENT: &str = "gid://shopify/ProductVariant/50668934103179";

/// Re-sign the quote in a raw Shopify input under `TEST_SECRET`.
fn sign_line(line: &mut Value, secret: &str) {
    let quote = parse_quote(line["payload"]["value"].as_str().unwrap()).unwrap();
    line["signature"]["value"] = Value::String(sign_hex(secret, &canonical_quote(&quote)));
}

fn base() -> Value {
    let mut input: Value = serde_json::from_str(FIXTURE).unwrap();
    sign_line(&mut input["cart"]["lines"][0], TEST_SECRET);
    input
}

fn normalized(raw: &Value) -> Input {
    run_function_with_input(
        |i| Ok::<_, Box<dyn std::error::Error>>(normalize(&i)),
        &raw.to_string(),
    )
    .expect("input parses")
}

fn codes_with(raw: &Value, secret: &str) -> Vec<&'static str> {
    run_validation(&normalized(raw), secret)
        .into_iter()
        .map(|e| e.code)
        .collect()
}

fn codes(raw: &Value) -> Vec<&'static str> {
    codes_with(raw, TEST_SECRET)
}

fn at_step(step: &str, f: impl FnOnce(&mut Value)) -> Value {
    let mut input = base();
    input["buyerJourney"]["step"] = json!(step);
    f(&mut input);
    input
}

// ------------------------------------------------------------------ the real capture

#[test]
fn the_capture_is_normalized_as_the_fix_assumes() {
    let n = normalized(&base());
    assert_eq!(n.buyer_step.as_deref(), Some("CHECKOUT_INTERACTION"));
    assert_eq!(n.lines.len(), 1);
    let line = &n.lines[0];
    assert_eq!(line.quantity, 100);
    assert!(line.is_product_variant && line.parent_line_id.is_none() && !line.has_selling_plan);
    assert_eq!(line.variant_gid.as_deref(), Some(LNY01_VARIANT));
    assert_eq!(line.money.per_unit_cents, Some(173));
    assert_eq!(line.money.subtotal_cents, Some(17_300));
    assert_eq!(line.money.currency.as_deref(), Some("USD"));
    assert!(n.shop_policy.is_some() && line.product_policy.is_some());
}

#[test]
fn the_real_lny01_checkout_is_allowed_at_every_step() {
    for step in [
        "CART_INTERACTION",
        "CHECKOUT_INTERACTION",
        "CHECKOUT_COMPLETION",
    ] {
        assert_eq!(codes(&at_step(step, |_| {})), Vec::<&str>::new(), "{step}");
    }
}

#[test]
fn an_altered_or_unexpanded_effective_price_is_rejected() {
    let altered = at_step("CHECKOUT_INTERACTION", |i| {
        i["cart"]["lines"][0]["cost"]["subtotalAmount"]["amount"] = json!("100.0");
        i["cart"]["lines"][0]["cost"]["amountPerQuantity"]["amount"] = json!("1.0");
    });
    assert_eq!(codes(&altered), vec!["effective_price_mismatch"]);
    let unexpanded = at_step("CHECKOUT_COMPLETION", |i| {
        i["cart"]["lines"][0]["cost"]["subtotalAmount"]["amount"] = json!("0.0");
        i["cart"]["lines"][0]["cost"]["amountPerQuantity"]["amount"] = json!("0.0");
    });
    assert_eq!(codes(&unexpanded), vec!["effective_price_mismatch"]);
}

#[test]
fn a_wrong_secret_a_tampered_signature_or_an_empty_secret_never_verifies() {
    assert_eq!(
        codes_with(&base(), "some-other-secret"),
        vec!["bad_signature"]
    );
    assert_eq!(
        codes_with(&base(), ""),
        vec!["bad_signature"],
        "an empty secret fails closed"
    );
    let tampered = at_step("CHECKOUT_INTERACTION", |i| {
        let sig = i["cart"]["lines"][0]["signature"]["value"]
            .as_str()
            .unwrap()
            .to_string();
        let flipped = if sig.starts_with('0') {
            format!("1{}", &sig[1..])
        } else {
            format!("0{}", &sig[1..])
        };
        i["cart"]["lines"][0]["signature"]["value"] = json!(flipped);
    });
    assert_eq!(codes(&tampered), vec!["bad_signature"]);
    let upper = at_step("CHECKOUT_INTERACTION", |i| {
        let sig = i["cart"]["lines"][0]["signature"]["value"]
            .as_str()
            .unwrap()
            .to_uppercase();
        i["cart"]["lines"][0]["signature"]["value"] = json!(sig);
    });
    assert_eq!(
        codes(&upper),
        vec!["bad_signature"],
        "the signature is compared exactly as lowercase hex"
    );
}

#[test]
fn a_missing_quote_a_wrong_quantity_or_a_stale_revision_is_rejected() {
    let no_quote = at_step("CHECKOUT_INTERACTION", |i| {
        for k in ["version", "payload", "signature", "config"] {
            i["cart"]["lines"][0][k] = Value::Null;
        }
    });
    assert_eq!(
        codes(&no_quote),
        vec!["v1_rejected"],
        "the reference rejects a non-2 version first"
    );
    assert_eq!(
        codes(&at_step("CHECKOUT_INTERACTION", |i| i["cart"]["lines"]
            [0]["quantity"] =
            json!(99))),
        vec!["quantity_mismatch"]
    );
    let stale = at_step("CHECKOUT_INTERACTION", |i| {
        i["shop"]["enforcementPolicy"]["jsonValue"]["policyRevision"] = json!(14)
    });
    assert_eq!(codes(&stale), vec!["policy_revision_mismatch"]);
    let rev = at_step("CHECKOUT_INTERACTION", |i| {
        i["cart"]["lines"][0]["merchandise"]["product"]["pricingPolicy"]["jsonValue"]
            ["profileRevision"] = json!(4)
    });
    assert_eq!(codes(&rev), vec!["profile_revision_mismatch"]);
}

#[test]
fn a_changed_config_breaks_the_digest_and_a_forged_quote_cannot_reuse_a_signature() {
    let changed = at_step("CHECKOUT_INTERACTION", |i| {
        let mut cfg: Value =
            serde_json::from_str(i["cart"]["lines"][0]["config"]["value"].as_str().unwrap())
                .unwrap();
        cfg["decorationChargeCodes"] = json!(["SETUP_FREE"]);
        i["cart"]["lines"][0]["config"]["value"] = json!(cfg.to_string());
    });
    assert_eq!(codes(&changed), vec!["config_digest_mismatch"]);
    // a forged payload (cheaper total) keeps the old signature: the HMAC covers the whole payload
    let forged = at_step("CHECKOUT_INTERACTION", |i| {
        let mut p: Value =
            serde_json::from_str(i["cart"]["lines"][0]["payload"]["value"].as_str().unwrap())
                .unwrap();
        p["flatSurchargeCents"] = json!(0);
        p["lineTotalCents"] = json!(13_700);
        i["cart"]["lines"][0]["payload"]["value"] = json!(p.to_string());
        i["cart"]["lines"][0]["cost"]["subtotalAmount"]["amount"] = json!("137.0");
    });
    assert_eq!(codes(&forged), vec!["bad_signature"]);
}

// ------------------------------------------------------------------ policy modes

#[test]
fn policy_modes_behave_as_in_the_reference() {
    let policy = |f: &dyn Fn(&mut Value)| {
        at_step("CHECKOUT_INTERACTION", |i| {
            f(&mut i["shop"]["enforcementPolicy"]["jsonValue"])
        })
    };
    assert!(
        codes(&policy(&|p| p["enabled"] = json!(false))).is_empty(),
        "the kill switch behaves as disabled"
    );
    assert!(codes(&policy(&|p| p["mode"] = json!("disabled"))).is_empty());
    assert_eq!(
        codes(&policy(&|p| p["mode"] = json!("maintenance"))),
        vec!["maintenance_block"]
    );
    assert!(codes(&policy(&|p| p["mode"] = json!("universal"))).is_empty());
    // malformed shop policy -> one global error, never a legacy fallback
    assert_eq!(
        codes(&policy(&|p| p["mode"] = json!("legacy"))),
        vec!["shop_policy_missing_or_malformed"]
    );
    assert_eq!(
        codes(&policy(&|p| p["surprise"] = json!(1))),
        vec!["shop_policy_missing_or_malformed"]
    );
    assert_eq!(
        codes(&policy(&|p| p["policyRevision"] = json!(0))),
        vec!["shop_policy_missing_or_malformed"]
    );
    let missing = at_step("CHECKOUT_INTERACTION", |i| {
        i["shop"]["enforcementPolicy"] = Value::Null
    });
    assert_eq!(codes(&missing), vec!["shop_policy_missing_or_malformed"]);
}

#[test]
fn product_policy_rules_under_pilot_and_universal() {
    let product = |f: &dyn Fn(&mut Value)| {
        at_step("CHECKOUT_INTERACTION", |i| {
            f(&mut i["cart"]["lines"][0]["merchandise"]["product"]["pricingPolicy"])
        })
    };
    // pilot: an unmarked product (no policy) and a not-required one are untouched
    assert!(
        codes(&at_step("CHECKOUT_INTERACTION", |i| i["cart"]["lines"]
            [0]["merchandise"]["product"]["pricingPolicy"] =
            Value::Null))
        .is_empty()
    );
    assert!(codes(&product(&|p| p["jsonValue"]["required"] = json!(false))).is_empty());
    // an inactive policy blocks checkout (the 144 products taken out of the pilot)
    assert_eq!(
        codes(&product(&|p| p["jsonValue"]["active"] = json!(false))),
        vec!["product_policy_inactive"]
    );
    assert_eq!(
        codes(&product(&|p| p["jsonValue"] = json!({ "schema": 1 }))),
        vec!["product_policy_missing_or_malformed"]
    );
    // universal: a missing policy blocks as well
    let universal = at_step("CHECKOUT_INTERACTION", |i| {
        i["shop"]["enforcementPolicy"]["jsonValue"]["mode"] = json!("universal");
        i["cart"]["lines"][0]["merchandise"]["product"]["pricingPolicy"] = Value::Null;
    });
    assert_eq!(
        codes(&universal),
        vec!["product_policy_missing_or_malformed"]
    );
}

#[test]
fn a_direct_adjustment_line_and_a_selling_plan_are_blocked() {
    let adjustment = at_step("CHECKOUT_INTERACTION", |i| {
        let mut line = i["cart"]["lines"][0].clone();
        line["id"] = json!("gid://shopify/CartLine/1");
        line["merchandise"]["id"] = json!(ADJUSTMENT);
        for k in ["version", "payload", "signature", "config"] {
            line[k] = Value::Null;
        }
        i["cart"]["lines"].as_array_mut().unwrap().push(line);
    });
    assert!(codes(&adjustment).contains(&"direct_adjustment"));
    let plan = at_step("CHECKOUT_INTERACTION", |i| {
        i["cart"]["lines"][0]["sellingPlanAllocation"] =
            json!({ "sellingPlan": { "id": "gid://shopify/SellingPlan/1" } })
    });
    assert_eq!(codes(&plan), vec!["selling_plan_unsupported"]);
}

#[test]
fn errors_are_bounded_deduplicated_and_sorted_by_code() {
    let many = at_step("CHECKOUT_INTERACTION", |i| {
        let line = i["cart"]["lines"][0].clone();
        for n in 1..12 {
            let mut copy = line.clone();
            copy["id"] = json!(format!("gid://shopify/CartLine/{n}"));
            copy["quantity"] = json!(99);
            i["cart"]["lines"].as_array_mut().unwrap().push(copy);
        }
    });
    let found = codes(&many);
    assert_eq!(
        found,
        vec!["quantity_mismatch"],
        "twelve identical failures collapse to one error"
    );
    let n = normalized(&many);
    let errs = run_validation(&n, TEST_SECRET);
    assert!(errs.len() <= MAX_ERRORS);
    assert!(errs.windows(2).all(|w| w[0].code <= w[1].code));
}

// ------------------------------------------------------------------ the exported entry point

#[test]
fn the_exported_function_returns_one_validation_add_with_customer_safe_messages() {
    let run_json = |raw: &Value, secret: &str| {
        run_function_with_input(|i| run(i, secret), &raw.to_string()).expect("the Function ran")
    };
    let ok = run_json(&base(), TEST_SECRET);
    assert_eq!(ok.operations.len(), 1);
    let schema::Operation::ValidationAdd(op) = &ok.operations[0];
    assert!(op.errors.is_empty());

    let bad = run_json(&base(), "wrong-secret");
    let schema::Operation::ValidationAdd(op) = &bad.operations[0];
    assert_eq!(op.errors.len(), 1);
    assert_eq!(op.errors[0].target, "$.cart");
    assert_eq!(op.errors[0].message, MSG_STALE);
    for e in &op.errors {
        assert!(
            !e.message.contains("gid://")
                && !e.message.contains("bad_signature")
                && !e.message.contains(TEST_SECRET)
        );
    }
}

// ------------------------------------------------------------------ unit tests of the helpers

#[test]
fn config_digest_is_canonical_integer_only_and_bounded() {
    // key order and spacing never change the digest; integral floats count as integers
    assert_eq!(
        config_digest(r#"{"b":1,"a":[2,3]}"#),
        config_digest(r#"{ "a": [2, 3.0], "b": 1.0 }"#)
    );
    assert_ne!(config_digest(r#"{"a":1}"#), config_digest(r#"{"a":2}"#));
    assert!(
        config_digest(r#"{"a":1.5}"#).is_none(),
        "a real fraction is not representable"
    );
    assert!(config_digest("not json").is_none());
    assert!(
        config_digest(&format!("[{}]", vec!["1"; 201].join(","))).is_none(),
        "array too long"
    );
    let deep = format!("{}1{}", "[".repeat(10), "]".repeat(10));
    assert!(config_digest(&deep).is_none(), "nesting too deep");
    assert!(
        config_digest(&format!("\"{}\"", "x".repeat(9000))).is_none(),
        "oversized"
    );
}

#[test]
fn integral_host_numbers_stay_integers() {
    assert!(number_to_serde(11.0).is_u64());
    assert!(number_to_serde(-3.0).is_i64());
    assert!(number_to_serde(1.5).is_f64());
    assert!(number_to_serde(9_007_199_254_740_992.0).is_f64());
    let policy = host_json(1.0, 13.0);
    assert!(
        parse_shop_policy(&policy).is_some(),
        "a policy whose numbers arrive as f64 parses"
    );
}

fn host_json(schema_number: f64, revision: f64) -> Value {
    json_value_to_serde(&JsonValue::Object(std::collections::BTreeMap::from([
        ("schema".to_string(), JsonValue::Number(schema_number)),
        ("mode".to_string(), JsonValue::String("pilot".into())),
        ("enabled".to_string(), JsonValue::Boolean(true)),
        (
            "adjustmentVariantGid".to_string(),
            JsonValue::String(ADJUSTMENT.into()),
        ),
        (
            "installBinding".to_string(),
            JsonValue::String("dev-imprintid-pricing-development-pilot-1".into()),
        ),
        ("policyRevision".to_string(), JsonValue::Number(revision)),
    ])))
}

#[test]
fn cents_conversion_accepts_whole_cents_only() {
    assert_eq!(amount_to_cents(1.73), Some(173));
    assert_eq!(amount_to_cents(173.0), Some(17_300));
    assert_eq!(amount_to_cents(0.0), Some(0));
    assert_eq!(amount_to_cents(0.36), Some(36));
    assert_eq!(amount_to_cents(1.234), None);
    assert_eq!(amount_to_cents(-1.0), None);
    assert_eq!(amount_to_cents(f64::NAN), None);
}

#[test]
fn component_integrity_matches_the_expanded_multiset() {
    let quote = parse_quote(
        base()["cart"]["lines"][0]["payload"]["value"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let component = |gid: &str, qty: i64, cents: u64| Observed {
        merchandise_gid: gid.into(),
        quantity: qty,
        per_unit_cents: Some(cents),
        currency: Some("USD".into()),
    };
    // $1.37 base + $0.36 setup per unit over 100 units: both components, exactly once
    assert!(!check_component_integrity(
        &quote,
        &[
            component(LNY01_VARIANT, 1, 137),
            component(ADJUSTMENT, 1, 36)
        ]
    ));
    assert!(
        !check_component_integrity(
            &quote,
            &[
                component(ADJUSTMENT, 1, 36),
                component(LNY01_VARIANT, 1, 137)
            ]
        ),
        "order does not matter"
    );
    assert!(
        check_component_integrity(&quote, &[component(LNY01_VARIANT, 1, 137)]),
        "a missing component"
    );
    assert!(
        check_component_integrity(
            &quote,
            &[
                component(LNY01_VARIANT, 1, 137),
                component(ADJUSTMENT, 1, 36),
                component(ADJUSTMENT, 1, 36)
            ]
        ),
        "a duplicate"
    );
    assert!(
        check_component_integrity(
            &quote,
            &[
                component(LNY01_VARIANT, 1, 137),
                component(ADJUSTMENT, 1, 35)
            ]
        ),
        "a changed amount"
    );
    assert!(
        check_component_integrity(
            &quote,
            &[
                component(LNY01_VARIANT, 2, 137),
                component(ADJUSTMENT, 1, 36)
            ]
        ),
        "a changed quantity"
    );
    let mut wrong_currency = component(ADJUSTMENT, 1, 36);
    wrong_currency.currency = Some("EUR".into());
    assert!(check_component_integrity(
        &quote,
        &[component(LNY01_VARIANT, 1, 137), wrong_currency]
    ));
}

// ------------------------------------------------------------------ differential test

/// 131 carts (policy modes, product policies, every quote field, quantity/price/currency variants,
/// component lines, direct adjustments) with the reject codes the TypeScript reference returns for
/// each. Regenerate with `node scripts/generate-parity-corpus.mjs` if the reference changes.
const PARITY_CORPUS: &str = include_str!("../fixtures/parity-corpus.json");

#[test]
fn the_rust_port_returns_exactly_the_typescript_references_codes_for_every_corpus_cart() {
    let corpus: Value = serde_json::from_str(PARITY_CORPUS).unwrap();
    let secret = corpus["secret"].as_str().unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 100, "the corpus is present and non-trivial");
    let mut mismatches = Vec::new();
    for case in cases {
        let expected: Vec<String> = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_string())
            .collect();
        let actual: Vec<String> = codes_with(&case["input"], secret)
            .into_iter()
            .map(str::to_string)
            .collect();
        if actual != expected {
            mismatches.push(format!(
                "{}: reference {:?}, rust {:?}",
                case["name"].as_str().unwrap(),
                expected,
                actual
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} carts differ:\n{}",
        mismatches.len(),
        cases.len(),
        mismatches.join("\n")
    );
}
