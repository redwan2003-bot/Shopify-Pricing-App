// Generates the differential-test corpus `src/fixtures/parity-corpus.json`: raw Shopify validation
// inputs plus the reject codes the TypeScript REFERENCE produces for them. The Rust port (see
// `the_rust_port_returns_exactly_the_typescript_references_codes_for_every_corpus_cart`) must return
// exactly the same codes for every case.
//
//   node scripts/generate-parity-corpus.mjs      (re-run after changing the reference)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const imp = (f) => import(pathToFileURL(`${ROOT}/${f}`).href);
const { runValidation } = await imp("cart_validations_generate_run.ts");
const { normalizeValidationInput } = await imp("normalize-input.ts");
const { canonicalizeCartPricingPayloadV2 } = await imp("cart-pricing-contract.ts");
const { signHex } = await imp("hmac-sha256.ts");
const { digestOfConfigJson } = await imp("config-normalization.ts");

const SECRET = "parity-test-secret-not-a-real-one";
const base = JSON.parse(readFileSync(`${ROOT}/fixtures/lny01-checkout-input.json`, "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

function signLine(line) {
  if (!line.payload?.value) return;
  try { line.signature = { value: signHex(SECRET, canonicalizeCartPricingPayloadV2(JSON.parse(line.payload.value))) }; } catch { /* leave as is */ }
}
function fresh() { const i = clone(base); signLine(i.cart.lines[0]); return i; }

const cases = [];
const add = (name, mutate) => {
  const input = fresh();
  mutate(input);
  const expected = runValidation(normalizeValidationInput(input), SECRET).map((e) => e.code);
  cases.push({ name, input, expected });
};
const L = (i) => i.cart.lines[0];
const SP = (i) => i.shop.enforcementPolicy.jsonValue;
const PP = (i) => L(i).merchandise.product.pricingPolicy;
/** mutate the signed payload; re-sign it unless `resign === false` */
const payload = (f, resign = true) => (i) => { const p = JSON.parse(L(i).payload.value); f(p); L(i).payload = { value: JSON.stringify(p) }; if (resign) signLine(L(i)); };

add("valid checkout", () => {});
for (const step of ["CART_INTERACTION", "CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION"]) {
  add(`valid at ${step}`, (i) => { i.buyerJourney.step = step; });
  add(`price altered at ${step}`, (i) => { i.buyerJourney.step = step; L(i).cost.subtotalAmount.amount = "100.0"; });
}

// shop policy
for (const mode of ["disabled", "pilot", "universal", "maintenance", "legacy", ""]) {
  for (const enabled of [true, false]) add(`shop mode=${mode} enabled=${enabled}`, (i) => { SP(i).mode = mode; SP(i).enabled = enabled; });
}
add("shop policy absent", (i) => { i.shop.enforcementPolicy = null; });
add("shop policy not an object", (i) => { i.shop.enforcementPolicy.jsonValue = "pilot"; });
add("shop extra key", (i) => { SP(i).extra = 1; });
add("shop schema 2", (i) => { SP(i).schema = 2; });
add("shop revision 0", (i) => { SP(i).policyRevision = 0; });
add("shop revision float", (i) => { SP(i).policyRevision = 13.5; });
add("shop revision integral float", (i) => { SP(i).policyRevision = 13.0; });
add("shop allowLegacyV1 true", (i) => { SP(i).allowLegacyV1 = true; });
add("shop allowLegacyV1 string", (i) => { SP(i).allowLegacyV1 = "yes"; });
add("shop enabled string", (i) => { SP(i).enabled = "true"; });
add("shop bad adjustment gid", (i) => { SP(i).adjustmentVariantGid = "gid://shopify/Product/1"; });
add("shop adjustment gid leading zero", (i) => { SP(i).adjustmentVariantGid = "gid://shopify/ProductVariant/0123"; });
add("shop empty installBinding", (i) => { SP(i).installBinding = ""; });
add("shop other install binding", (i) => { SP(i).installBinding = "someone-else"; });
add("shop other adjustment variant", (i) => { SP(i).adjustmentVariantGid = "gid://shopify/ProductVariant/777"; });

// product policy
add("product policy absent", (i) => { PP(i).jsonValue = null; });
add("product policy pricingPolicy null", (i) => { L(i).merchandise.product.pricingPolicy = null; });
add("product inactive", (i) => { PP(i).jsonValue.active = false; });
add("product required false", (i) => { PP(i).jsonValue.required = false; });
add("product required false + inactive", (i) => { PP(i).jsonValue.required = false; PP(i).jsonValue.active = false; });
add("product schema 2", (i) => { PP(i).jsonValue.schema = 2; });
add("product extra key", (i) => { PP(i).jsonValue.x = 1; });
add("product empty profileRef", (i) => { PP(i).jsonValue.profileRef = ""; });
add("product profileRef other", (i) => { PP(i).jsonValue.profileRef = "other"; });
add("product profileRevision other", (i) => { PP(i).jsonValue.profileRevision = 9; });
for (const mode of ["pilot", "universal"]) {
  add(`${mode}: product absent`, (i) => { SP(i).mode = mode; PP(i).jsonValue = null; });
  add(`${mode}: product inactive`, (i) => { SP(i).mode = mode; PP(i).jsonValue.active = false; });
  add(`${mode}: product required false`, (i) => { SP(i).mode = mode; PP(i).jsonValue.required = false; });
  add(`${mode}: product malformed`, (i) => { SP(i).mode = mode; PP(i).jsonValue = { schema: 1 }; });
}

// the quote
add("no quote attributes", (i) => { for (const k of ["version", "payload", "signature", "config"]) L(i)[k] = null; });
add("version 1", (i) => { L(i).version = { value: "1" }; });
add("version null only", (i) => { L(i).version = null; });
add("payload null only", (i) => { L(i).payload = null; });
add("signature null only", (i) => { L(i).signature = null; });
add("config null only", (i) => { L(i).config = null; });
add("empty signature", (i) => { L(i).signature = { value: "" }; });
add("signature flipped", (i) => { const s = L(i).signature.value; L(i).signature = { value: (s[0] === "0" ? "1" : "0") + s.slice(1) }; });
add("signature uppercase", (i) => { L(i).signature = { value: L(i).signature.value.toUpperCase() }; });
add("signature wrong length", (i) => { L(i).signature = { value: L(i).signature.value.slice(0, 60) }; });
add("payload not json", (i) => { L(i).payload = { value: "{nope" }; });
add("payload oversized", (i) => { L(i).payload = { value: "x".repeat(5000) }; });
add("config oversized", (i) => { L(i).config = { value: JSON.stringify({ a: "x".repeat(9000) }) }; });
add("config not json", (i) => { L(i).config = { value: "{nope" }; });
add("config changed", (i) => { const c = JSON.parse(L(i).config.value); c.decorationChargeCodes = ["SETUP_FREE"]; L(i).config = { value: JSON.stringify(c) }; });
add("config key order changed (same digest)", (i) => { const c = JSON.parse(L(i).config.value); L(i).config = { value: JSON.stringify(Object.fromEntries(Object.entries(c).reverse())) }; });
add("config with a fraction", (i) => { const c = JSON.parse(L(i).config.value); c.quantity = 100.5; L(i).config = { value: JSON.stringify(c) }; });
add("config with integral float text", (i) => { L(i).config = { value: L(i).config.value.replace('"quantity":100', '"quantity":100.0') }; });
add("payload install other (resigned)", payload((p) => { p.installBinding = "x"; }));
add("payload adjustment other (resigned)", payload((p) => { p.adjustmentVariantGid = "gid://shopify/ProductVariant/1"; }));
add("payload policyRevision other (resigned)", payload((p) => { p.policyRevision = 12; }));
add("payload profileRef other (resigned)", payload((p) => { p.profileRef = "x"; }));
add("payload profileRevision other (resigned)", payload((p) => { p.profileRevision = 1; }));
add("payload variant other (resigned)", payload((p) => { p.variantGid = "gid://shopify/ProductVariant/1"; }));
add("payload product other (resigned)", payload((p) => { p.productGid = "gid://shopify/Product/1"; }));
add("payload quantity other (resigned)", payload((p) => { p.quantity = 101; p.lineTotalCents = p.baseUnitPriceCents * 101 + p.flatSurchargeCents; }));
add("payload currency EUR (resigned)", payload((p) => { p.currency = "EUR"; }));
add("payload currency ' usd ' (resigned)", payload((p) => { p.currency = " usd "; }));
add("payload currency bad (resigned)", payload((p) => { p.currency = "US"; }));
add("payload digest wrong (resigned)", payload((p) => { p.configDigest = "sha256:00"; }));
add("payload total inconsistent (resigned)", payload((p) => { p.lineTotalCents = 1; }));
add("payload base huge (resigned)", payload((p) => { p.baseUnitPriceCents = 10_000_000_000; p.lineTotalCents = 1; }));
add("payload quantity huge (resigned)", payload((p) => { p.quantity = 2_000_000; }));
add("payload quantity 0 (resigned)", payload((p) => { p.quantity = 0; }));
add("payload extra field (resigned)", payload((p) => { p.extra = 1; }));
add("payload missing field (resigned)", payload((p) => { delete p.quoteId; }));
add("payload v=1 (resigned)", payload((p) => { p.v = 1; }));
add("payload number as string (resigned)", payload((p) => { p.quantity = "100"; }));
add("payload negative (resigned)", payload((p) => { p.flatSurchargeCents = -1; }));
add("payload float quantity (resigned)", payload((p) => { p.quantity = 100.0; }));
add("payload tampered without resign", payload((p) => { p.flatSurchargeCents = 0; p.lineTotalCents = 13700; }, false));
add("payload with a per-unit surcharge (resigned)", payload((p) => { p.perUnitSurchargeCents = 5; p.flatSurchargeCents = 0; p.lineTotalCents = (p.baseUnitPriceCents + 5) * p.quantity; }));
add("payload zero total (resigned)", payload((p) => { p.baseUnitPriceCents = 0; p.flatSurchargeCents = 0; p.lineTotalCents = 0; }));

// the cart line
add("quantity 99", (i) => { L(i).quantity = 99; });
add("quantity 0", (i) => { L(i).quantity = 0; });
add("subtotal zero", (i) => { L(i).cost.subtotalAmount.amount = "0.0"; L(i).cost.amountPerQuantity.amount = "0.0"; });
add("subtotal 3 decimals (not whole cents)", (i) => { L(i).cost.subtotalAmount.amount = "173.004"; });
add("subtotal integer text", (i) => { L(i).cost.subtotalAmount.amount = "173"; });
add("subtotal 173.00 text", (i) => { L(i).cost.subtotalAmount.amount = "173.00"; });
add("subtotal 173.01", (i) => { L(i).cost.subtotalAmount.amount = "173.01"; });
add("currency EUR on line", (i) => { L(i).cost.subtotalAmount.currencyCode = "EUR"; });
add("selling plan", (i) => { L(i).sellingPlanAllocation = { sellingPlan: { id: "gid://shopify/SellingPlan/1" } }; });
add("custom product (not a variant)", (i) => { L(i).merchandise = { __typename: "CustomProduct" }; });
add("variant is the adjustment", (i) => { L(i).merchandise.id = SP(i).adjustmentVariantGid; });
add("empty cart", (i) => { i.cart.lines = []; });
add("empty cart, no shop policy", (i) => { i.cart.lines = []; i.shop.enforcementPolicy = null; });
add("two valid lines", (i) => { const c = clone(L(i)); c.id = "gid://shopify/CartLine/1"; i.cart.lines.push(c); });
add("valid + altered line", (i) => { const c = clone(L(i)); c.id = "gid://shopify/CartLine/1"; c.cost.subtotalAmount.amount = "1.0"; i.cart.lines.push(c); });
add("six distinct failures", (i) => {
  const kinds = [(c) => (c.quantity = 99), (c) => { c.version = { value: "1" }; }, (c) => { c.cost.subtotalAmount.amount = "1.0"; }, (c) => { c.sellingPlanAllocation = { sellingPlan: { id: "x" } }; }, (c) => { c.merchandise.product.pricingPolicy.jsonValue.active = false; }, (c) => { c.merchandise.product.pricingPolicy.jsonValue = { schema: 1 }; }, (c) => { c.signature = { value: "0".repeat(64) }; }];
  kinds.forEach((f, n) => { const c = clone(L(i)); c.id = `gid://shopify/CartLine/${n + 1}`; f(c); i.cart.lines.push(c); });
});

// component lines (an expanded cart): parent + children
const child = (id, parent, variant, qty, amount) => ({
  id, quantity: qty, cost: { amountPerQuantity: { amount }, subtotalAmount: { amount, currencyCode: "USD" } }, sellingPlanAllocation: null,
  merchandise: { __typename: "ProductVariant", id: variant, product: { id: "gid://shopify/Product/9", pricingPolicy: null } },
  version: null, payload: null, signature: null, config: null, parentRelationship: { parent: { id: parent } },
});
const PARENT = "gid://shopify/CartLine/0", V = "gid://shopify/ProductVariant/49375196872843", A = "gid://shopify/ProductVariant/50668934103179";
add("components valid", (i) => { i.cart.lines.push(child("c1", PARENT, V, 1, "1.37"), child("c2", PARENT, A, 1, "0.36")); });
add("components reversed", (i) => { i.cart.lines.push(child("c2", PARENT, A, 1, "0.36"), child("c1", PARENT, V, 1, "1.37")); });
add("components missing adjustment", (i) => { i.cart.lines.push(child("c1", PARENT, V, 1, "1.37")); });
add("components duplicate adjustment", (i) => { i.cart.lines.push(child("c1", PARENT, V, 1, "1.37"), child("c2", PARENT, A, 1, "0.36"), child("c3", PARENT, A, 1, "0.36")); });
add("components wrong amount", (i) => { i.cart.lines.push(child("c1", PARENT, V, 1, "1.37"), child("c2", PARENT, A, 1, "0.35")); });
add("components wrong quantity", (i) => { i.cart.lines.push(child("c1", PARENT, V, 2, "1.37"), child("c2", PARENT, A, 1, "0.36")); });
add("components wrong adjustment variant", (i) => { i.cart.lines.push(child("c1", PARENT, V, 1, "1.37"), child("c2", PARENT, "gid://shopify/ProductVariant/999", 1, "0.36")); });
add("components wrong currency", (i) => { const c = child("c2", PARENT, A, 1, "0.36"); c.cost.subtotalAmount.currencyCode = "EUR"; i.cart.lines.push(child("c1", PARENT, V, 1, "1.37"), c); });
add("component with bad amount", (i) => { i.cart.lines.push(child("c1", PARENT, V, 1, "1.37"), child("c2", PARENT, A, 1, "0.356")); });
add("orphan component", (i) => { i.cart.lines.push(child("c1", "gid://shopify/CartLine/zzz", V, 1, "1.37")); });
add("component of a non-variant parent", (i) => { L(i).merchandise = { __typename: "CustomProduct" }; i.cart.lines.push(child("c1", PARENT, V, 1, "1.37")); });
add("component, parent policy inactive", (i) => { PP(i).jsonValue.active = false; i.cart.lines.push(child("c1", PARENT, V, 1, "1.37"), child("c2", PARENT, A, 1, "0.36")); });
add("component, parent bad signature", (i) => { L(i).signature = { value: "0".repeat(64) }; i.cart.lines.push(child("c1", PARENT, V, 1, "1.37"), child("c2", PARENT, A, 1, "0.36")); });
add("components under disabled policy", (i) => { SP(i).mode = "disabled"; i.cart.lines.push(child("c1", PARENT, V, 1, "1.37")); });
add("components under cart interaction", (i) => { i.buyerJourney.step = "CART_INTERACTION"; i.cart.lines.push(child("c1", PARENT, V, 1, "9.99")); });
add("direct adjustment line + valid", (i) => { const a = clone(L(i)); a.id = "gid://shopify/CartLine/7"; a.merchandise.id = A; a.version = a.payload = a.signature = a.config = null; i.cart.lines.push(a); });
for (const mode of ["disabled", "pilot", "universal", "maintenance"]) {
  add(`direct adjustment under ${mode}`, (i) => { SP(i).mode = mode; const a = clone(L(i)); a.id = "gid://shopify/CartLine/7"; a.merchandise.id = A; a.version = a.payload = a.signature = a.config = null; i.cart.lines = [a]; });
}

const nonEmpty = cases.filter((c) => c.expected.length).length;
writeFileSync(`${ROOT}/fixtures/parity-corpus.json`, JSON.stringify({ secret: SECRET, cases }, null, 0) + "\n");
console.log(`cases: ${cases.length} | with errors: ${nonEmpty} | clean: ${cases.length - nonEmpty}`);
const codeCounts = {};
for (const c of cases) for (const code of c.expected) codeCounts[code] = (codeCounts[code] ?? 0) + 1;
console.log("reject codes covered:", Object.entries(codeCounts).sort().map(([k, v]) => `${k}:${v}`).join(" "));
