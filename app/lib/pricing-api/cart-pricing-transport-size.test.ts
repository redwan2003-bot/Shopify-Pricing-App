import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ENVELOPE_V2,
  canonicalizeCartPricingPayloadV2,
  CART_PRICING_LIMITS,
  type CartPricingPayloadV2,
} from "./cart-pricing-contract.ts";
import { normalizeConfig, digestOfConfigJson } from "./config-normalization.ts";
import { signHex } from "./hmac-sha256.ts";
import { parseV2Payload } from "../../../extensions/imprintid-cart-pricing/src/verify-payload-v2.ts";
import { cartLineAttributesFromSignedPricing } from "../../../extensions/imprintid-dynamic-pricing/assets/dynamic-pricing-utils.js";

/**
 * Task 5B.1.1 §6 — transport byte-size audit.
 *
 * Measures the actual UTF-8 byte length (NOT `String.length`) of the signed-quote
 * envelope, its config attribute, and the complete `/cart/add.js` properties object at
 * several configuration sizes, and proves an end-to-end round-trip:
 *   storefront helper → JSON.stringify → Function attribute parser → digest verification.
 *
 * IMPORTANT: the 4096 / 8192 byte limits in `CART_PRICING_LIMITS` are THIS system's own
 * conservative bounds. They are NOT documented Shopify cart-line-property guarantees.
 * Live per-surface property-size verification (theme AJAX cart, Storefront API,
 * accelerated checkout, checkout completion) remains a Task 5B.2 / 5C release gate.
 */

const SECRET = "transport-size-secret";
const ADJ = "gid://shopify/ProductVariant/999";
const PRODUCT = "gid://shopify/Product/9442404663548";
const VARIANT = "gid://shopify/ProductVariant/51028263796988"; // realistic 14-digit id

function utf8 (s: string): number {
  return new TextEncoder().encode(s).length;
}

function makeQuote(configInput: unknown): {
  payloadJson: string;
  configJson: string;
  signature: string;
  cartPricing: { version: number; payload: string; signature: string; config: string };
} {
  const n = normalizeConfig(configInput);
  if (!n.ok) throw new Error(`config did not normalize: ${n.reason}`);
  const components = { baseUnitPriceCents: 137, perUnitSurchargeCents: 24, flatSurchargeCents: 8900, quantity: 1000 };
  const payload: CartPricingPayloadV2 = {
    v: ENVELOPE_V2,
    installBinding: "install-binding-9f2c1a7e4b",
    productGid: PRODUCT,
    variantGid: VARIANT,
    quantity: components.quantity,
    currency: "USD",
    baseUnitPriceCents: components.baseUnitPriceCents,
    perUnitSurchargeCents: components.perUnitSurchargeCents,
    flatSurchargeCents: components.flatSurchargeCents,
    lineTotalCents: components.baseUnitPriceCents * components.quantity + components.perUnitSurchargeCents * components.quantity + components.flatSurchargeCents,
    adjustmentVariantGid: ADJ,
    profileRef: "prof_LNY01",
    profileRevision: 12,
    policyRevision: 7,
    configDigest: n.digest,
    quoteId: "01J8ZK7M3QW9F5X2R0T4H8N6VC",
    issuedAtServer: 1_725_000_000,
  };
  const payloadJson = JSON.stringify(payload);
  const signature = signHex(SECRET, canonicalizeCartPricingPayloadV2(payload));
  const cartPricing = { version: 2, payload: payloadJson, signature, config: n.canonicalJson };
  return { payloadJson, configJson: n.canonicalJson, signature, cartPricing };
}

/** The configuration shapes `buildConfigDigestInput` produces server-side. */
const SMALLEST_LNY01 = {
  quantity: 100,
  productColorCode: null,
  decorationMethod: null,
  decorationChargeCodes: [] as string[],
  optionValueIds: [] as string[],
  productionCode: "STANDARD",
  packagingCode: null,
};
const REALISTIC_LNY01 = {
  quantity: 1000,
  productColorCode: null,
  decorationMethod: "SCREEN_PRINT",
  decorationChargeCodes: ["LNY-SETUP", "LNY-RUN-2C", "LNY-2ND-LOC", "LNY-REVERSE-DIFF"],
  optionValueIds: ["ov_attach_std_01", "ov_feature_safety_breakaway", "ov_feature_bulk_pack"],
  productionCode: "RUSH",
  packagingCode: "BULK-CARTON",
};
const NON_ASCII_LNY01 = {
  ...REALISTIC_LNY01,
  note: "Bleu marine — logo « éclair » ✦ 中文标签 / لافتة",
};

function reportRow(name: string, quote: ReturnType<typeof makeQuote>) {
  const propsObj = cartLineAttributesFromSignedPricing(quote.cartPricing);
  assert.ok(propsObj, `${name}: helper must produce attributes`);
  const propsJson = JSON.stringify(propsObj);
  // eslint-disable-next-line no-console
  console.log(
    `  ${name.padEnd(28)} payload=${String(utf8(quote.payloadJson)).padStart(5)}B  config=${String(utf8(quote.configJson)).padStart(5)}B  signature=${utf8(quote.signature)}B  /cart/add.js props=${String(utf8(propsJson)).padStart(5)}B`,
  );
  return { payloadBytes: utf8(quote.payloadJson), configBytes: utf8(quote.configJson), propsBytes: utf8(propsJson), propsObj };
}

test("§6 transport byte sizes — reported, all within this system's own limits", () => {
  // eslint-disable-next-line no-console
  console.log("\n=== Task 5B.1.1 §6 — signed-quote transport byte sizes (UTF-8) ===");
  const rows = {
    smallest: reportRow("LNY01 smallest config", makeQuote(SMALLEST_LNY01)),
    realistic: reportRow("LNY01 realistic full quote", makeQuote(REALISTIC_LNY01)),
    nonAscii: reportRow("LNY01 non-ASCII config", makeQuote(NON_ASCII_LNY01)),
  };

  for (const [name, r] of Object.entries(rows)) {
    assert.ok(r.payloadBytes <= CART_PRICING_LIMITS.maxPayloadBytes, `${name} payload ${r.payloadBytes}B exceeds ${CART_PRICING_LIMITS.maxPayloadBytes}`);
    assert.ok(r.configBytes <= CART_PRICING_LIMITS.maxConfigBytes, `${name} config ${r.configBytes}B exceeds ${CART_PRICING_LIMITS.maxConfigBytes}`);
  }
  // Non-ASCII content genuinely costs more bytes than characters.
  const na = makeQuote(NON_ASCII_LNY01);
  assert.ok(utf8(na.configJson) > na.configJson.length, "non-ASCII config: UTF-8 bytes must exceed String.length");
});

test("§6 a maximum-size normalized configuration is measured and still round-trips", () => {
  // Build a config that approaches the 8192-byte config limit.
  const bigOptionIds = Array.from({ length: 120 }, (_, i) => `ov_generated_option_value_${String(i).padStart(3, "0")}`);
  const maxConfig = { ...REALISTIC_LNY01, optionValueIds: bigOptionIds, decorationChargeCodes: Array.from({ length: 20 }, (_, i) => `LNY-CHARGE-${i}`) };
  const quote = makeQuote(maxConfig);
  const r = reportRow("LNY01 near-max config", quote);
  assert.ok(r.configBytes <= CART_PRICING_LIMITS.maxConfigBytes);
  assert.ok(r.configBytes > 4000, "the near-max fixture should actually be large");

  // round-trip: helper props -> JSON -> Function parser -> digest verification
  const propsJson = JSON.stringify(r.propsObj);
  const reparsedProps = JSON.parse(propsJson) as Record<string, string>;
  const parsed = parseV2Payload(reparsedProps._imprintid_pricing_payload);
  assert.ok(parsed, "Function parser accepts the round-tripped payload");
  const recomputed = digestOfConfigJson(reparsedProps._imprintid_pricing_config);
  assert.ok(recomputed.ok);
  if (parsed && recomputed.ok) assert.equal(recomputed.digest, parsed.configDigest, "digest survives the round-trip exactly");
  if (parsed) assert.equal(parsed.v, 2);
});

test("§6 oversize config fails closed BEFORE /cart/add.js — never truncated", () => {
  // A config whose serialized form exceeds the limit does not normalize at all.
  const oversize = { ...REALISTIC_LNY01, blob: "x".repeat(9000) };
  const n = normalizeConfig(oversize);
  assert.equal(n.ok, false);
  if (!n.ok) assert.equal(n.reason, "too_large");

  // And an over-limit config attribute reaching the storefront helper is rejected (null),
  // so the add-to-cart POST is aborted rather than sending truncated signed data.
  const good = makeQuote(REALISTIC_LNY01);
  const tampered = { ...good.cartPricing, config: "y".repeat(9000) };
  assert.equal(cartLineAttributesFromSignedPricing(tampered), null);
});

test("§6 non-ASCII payload round-trips through JSON + the Function parser with an exact digest match", () => {
  const quote = makeQuote(NON_ASCII_LNY01);
  const props = cartLineAttributesFromSignedPricing(quote.cartPricing);
  assert.ok(props);
  const wire = JSON.parse(JSON.stringify(props)) as Record<string, string>;
  const parsed = parseV2Payload(wire._imprintid_pricing_payload);
  assert.ok(parsed);
  const digest = digestOfConfigJson(wire._imprintid_pricing_config);
  assert.ok(digest.ok);
  if (parsed && digest.ok) assert.equal(digest.digest, parsed.configDigest);
});
