import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runValidation } from "./cart_validations_generate_run.ts";
import { normalizeValidationInput } from "./normalize-input.ts";
import { canonicalizeCartPricingPayloadV2 } from "./cart-pricing-contract.ts";
import { signHex } from "./hmac-sha256.ts";

/**
 * Regression tests built from the REAL input Shopify gave this Function at checkout on
 * 2026-11-02 for LNY01, quantity 100, default screen print (one colour, one location), after the
 * Cart Transform had expanded the line:
 *
 *   - exactly ONE top-level line, no component lines (`parentRelationship: null`);
 *   - `amountPerQuantity` 1.73 and `subtotalAmount` 173.0 — the EFFECTIVE price, i.e. the
 *     product ($1.37) plus the one-time $36.00 setup charge spread over 100 units ($0.36).
 *
 * That is the post-Transform representation `EFFECTIVE_PRICE_ENFORCED` was waiting for. The
 * fixture's signature was made with the production secret, so each test re-signs the quote under
 * a throwaway secret (the payload itself is the real one).
 */

const SECRET = "real-capture-test-secret-not-a-real-one";
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/lny01-checkout-input.json", import.meta.url), "utf8"));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capture(step = "CHECKOUT_INTERACTION", mutate?: (line: any, input: any) => void) {
  const input = JSON.parse(JSON.stringify(FIXTURE));
  input.buyerJourney = { step };
  const line = input.cart.lines[0];
  const payload = JSON.parse(line.payload.value);
  line.signature.value = signHex(SECRET, canonicalizeCartPricingPayloadV2(payload));
  mutate?.(line, input);
  return normalizeValidationInput(input);
}

const codes = (n: ReturnType<typeof capture>) => runValidation(n, SECRET).map((e) => e.code);

test("the captured cart is what the fix assumes: one expanded line at $1.73 x 100 = $173.00 with no components", () => {
  assert.equal(FIXTURE.cart.lines.length, 1);
  const line = FIXTURE.cart.lines[0];
  assert.equal(line.parentRelationship, null);
  assert.equal(line.quantity, 100);
  assert.equal(line.cost.amountPerQuantity.amount, "1.73");
  assert.equal(line.cost.subtotalAmount.amount, "173.0");
  const payload = JSON.parse(line.payload.value);
  assert.equal(payload.lineTotalCents, 17300);
  assert.equal(payload.baseUnitPriceCents * payload.quantity + payload.flatSurchargeCents, 17300);
});

test("the real LNY01 checkout is ALLOWED at cart, checkout and completion steps", () => {
  for (const step of ["CART_INTERACTION", "CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"]) {
    assert.deepEqual(codes(capture(step)), [], step);
  }
});

test("the same real cart is rejected when the effective price was altered", () => {
  const altered = capture("CHECKOUT_INTERACTION", (l) => {
    l.cost.subtotalAmount.amount = "100.0";
    l.cost.amountPerQuantity.amount = "1.0";
  });
  assert.deepEqual(codes(altered), ["effective_price_mismatch"]);
});

test("the same real cart is rejected when the Transform did not run (line still at $0.00)", () => {
  const unexpanded = capture("CHECKOUT_INTERACTION", (l) => {
    l.cost.subtotalAmount.amount = "0.0";
    l.cost.amountPerQuantity.amount = "0.0";
  });
  assert.deepEqual(codes(unexpanded), ["effective_price_mismatch"]);
});

test("the same real cart is rejected when the signature, quantity or quote is missing or wrong", () => {
  const badSignature = capture("CHECKOUT_INTERACTION", (l) => {
    const s = l.signature.value as string;
    l.signature.value = (s[0] === "0" ? "1" : "0") + s.slice(1);
  });
  assert.ok(codes(badSignature).length >= 1);
  assert.ok(codes(capture("CHECKOUT_INTERACTION", (l) => { l.quantity = 99; })).length >= 1);
  const noQuote = capture("CHECKOUT_INTERACTION", (l) => { l.version = null; l.payload = null; l.signature = null; l.config = null; });
  assert.ok(codes(noQuote).length >= 1);
});

test("the same real cart is rejected under a different shop policy revision (a stale quote)", () => {
  const stale = capture("CHECKOUT_INTERACTION", (_l, input) => { input.shop.enforcementPolicy.jsonValue.policyRevision = 14; });
  assert.ok(codes(stale).length >= 1);
});
