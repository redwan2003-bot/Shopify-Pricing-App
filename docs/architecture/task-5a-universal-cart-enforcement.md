# Task 5A — Universal Dynamic Cart-Pricing Enforcement Architecture

Status: **architecture & feasibility.** No extension was generated, no metafield/Shopify
data written, nothing deployed or activated.

> **Task 5B.1 + 5B.1.1 corrections applied** (see the CHANGE LOG at the end). The v2
> contract, config normalization, Cart Transform hardening, generated Function types,
> strict policy parsing, envelope-selection safety, and shared golden vectors are
> implemented locally. **No implicit legacy fail-open**: a missing/malformed shop policy
> ⇒ no Transform operation; the server issues v1 only under an explicit non-production
> authorization. The Cart & Checkout Validation extension is **not** created — it needs a
> Shopify-managed UID (see §16). Native-price exposure remains until Validation is active,
> so cart signing / enforced rollout stay disabled.

Repo state at authoring: branch `main`, HEAD `2f0dac8` (single baseline commit; all Task 2/4
work uncommitted in the working tree). Function API version pinned: **`2026-07`**
(`extensions/imprintid-cart-pricing/shopify.extension.toml`). Dev server running
(ports 65299 app / 65296 CLI proxy / 3457 GraphiQL / 9293 theme extension).

---

## 1. Executive decision

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **The current Cart Transform (`lineExpand` + `fixedPricePerUnit` price adjustment) is retained as the pricing mechanism, but is NOT sufficient for enforcement on its own.** | A Cart Transform only *prices* lines that carry a valid quote; it silently no-ops on tampered / missing / direct-adjustment-variant lines, leaving the native variant price. Enforcement requires a second, independent **Cart & Checkout Validation Function** that *blocks* the cart. |
| D2 | **A public-app (App Store) distribution is required.** | Constraint #6 (confirmed verbatim): *"Only stores on a Shopify Plus plan can use custom apps that contain Shopify Function APIs."* ImprintID's target merchant is not guaranteed Plus and has 6,500+ products. A **custom-distributed** app with *any* Function (Transform **or** Validation) is dead on a non-Plus store. Only a public App Store app runs Functions on all plans. |
| D3 | **Basic-plan production pricing via `lineExpand` price adjustment is CONDITIONAL** — *technically indicated by current documentation, pending written Shopify confirmation and production-plan testing.* Not classified as proven-supported nor proven-unsupported. | Current official Cart Transform docs (fetched Task 5A) restrict **only** `update`/`lineUpdate` to development stores / Shopify Plus and state **no** such restriction for `lineExpand`/`linesMerge`. The repo's old code comment claiming otherwise was based on a prior/incorrect reading and has been corrected. Because a *price-overriding* expand is still a stronger capability than a plain bundle expand, confirm in writing with Shopify for the exact target plan + distribution, and test on a real Basic production store, before go-live. Do not design around it with unsupported hacks. |
| D4 | **Enforcement policy is 100 % app-owned metafields.** Customer-controlled line properties never decide whether enforcement applies — only *carry* the signed quote for verification. | Constraint #9. |
| D5 | **Replay/expiry protection is revision-bound, not clock-bound.** | Constraint #8: Functions are deterministic and cannot read the clock. `Date.now()` in the current Transform is a latent defect (see §2). Quotes bind `profileRevision` + `policyRevision`; the Validation Function reads the *current* revision from the product/shop metafield in its input query and fails closed on mismatch. |
| D6 | **Universal mode fails closed:** once `mode = "universal"`, an ordinary product with no valid product-policy metafield is **blocked at checkout**, not sold at native price. | Task §5 requirement. Guarded behind an explicit, reversible mode flag so rollout is staged. |
| D7 | **Task 5A ships the contract + this document + golden test vectors + POC tests only.** Signing behavior, the Function bundle, and metafields are unchanged. | Task scope + "do not change existing production signing behavior". |

**Go/No-Go for live storefront enforcement:** **NO-GO** until the blockers in §14 clear — chiefly
D3 (plan/operation confirmation), the missing signing-secret + adjustment-variant configuration,
the `Date.now()` defect, the envelope gaps (no product GID / profile revision / config digest),
and Task 4A.5 (native-button containment) which **does not yet exist in the repo**.

---

## 2. Current implementation audit

### 2.1 Cart Transform Function — `imprintid-cart-pricing`

| Aspect | Finding |
|---|---|
| Target | `cart.transform.run` (export `cart-transform-run`), API version `2026-07`, uid `e17f4c6a-…` |
| Operation | **`lineExpand`** only. (Not `lineUpdate`, not `linesMerge`.) |
| Adjustment variant | One merchant-configured variant GID (`IMPRINTID_ADJUSTMENT_VARIANT_ID`), **signed into the payload** as `adjustmentVariantId`. Used as `merchandiseId` for surcharge components. |
| Price change model | Line is **expanded** into ≤3 components: base = real cart variant @ `baseUnitPriceCents` (per unit × qty); per-unit surcharge = adjustment variant @ `perUnitSurchargeCents` (per unit × qty); flat surcharge = adjustment variant @ `flatSurchargeCents` (× 1). Each carries `price.adjustment.fixedPricePerUnit.amount`. It **overrides** effective line price via the adjustment; it does not call `lineUpdate`. |
| Cart-line fields read | `line.id`, `line.quantity`, `line.merchandise.id` (`ProductVariant` only), and three attributes: `_imprintid_pricing_version`, `_imprintid_pricing_payload`, `_imprintid_pricing_signature`. Also top-level `presentmentCurrencyRate`. **Nothing else** — no product id, no metafields, no line properties, no cart currency code. |
| Canonical payload | `CartPricingPayload = { v:1, sku, quantity, currency, baseVariantId, baseUnitPriceCents, perUnitSurchargeCents, flatSurchargeCents, adjustmentVariantId, expiresAt }`. Transport attribute = `JSON.stringify(payload)`. Signed form = **sorted `key=value` joined with `\n`** (`canonicalize`), identical spec on both sides. |
| Signature | **HMAC-SHA256**, lowercase hex, self-contained FIPS-180-4/RFC-2104 implementation (`hmac-sha256.ts`), constant-time hex compare (`timingSafeEqualHex`). Attribute `version` must equal `"1"`. |
| Cryptographically bound fields | **All 10 payload fields** are in the canonical string → all bound: `v, sku, quantity, currency, baseVariantId, baseUnitPriceCents, perUnitSurchargeCents, flatSurchargeCents, adjustmentVariantId, expiresAt`. |
| Product ID binding | **NOT bound.** No product GID in the payload. Only `baseVariantId` + `sku`. |
| Variant ID binding | `baseVariantId` bound **and enforced**: `payload.baseVariantId === cartLine.merchandiseId` else `variant_mismatch`. |
| Quantity binding | `quantity` bound **and enforced**: exact `===` match else `quantity_mismatch`. |
| Currency binding | `currency` bound in signature but **never checked** at runtime — the Function has no cart-currency field. `presentmentCurrencyRate` is applied blindly. |
| Unit price / total binding | `baseUnitPriceCents` bound. No single `total` field; total is reconstructed from the 3 components (all bound). No independent check that the reconstructed total equals a signed `lineTotal`. |
| Configuration binding | **NOT bound.** No config digest. `sku` is the only "which configuration" signal, and one SKU/variant has many priced configurations. |
| Pricing-profile identity | **NOT bound.** No `profileId` / `profileRevision`. `sku` only. |
| Missing/malformed signature | `verifyCartPricingAttributes` → `{ ok:false }` → `continue`. Line left at **native variant price**. Fail-**safe** (no transform, no block). |
| Altered quantity after add | `quantity_mismatch` → line reverts to **native variant price**. Fail-safe, but the enforced price silently disappears — a genuine bypass surface with no Validation layer. |
| Direct add of the adjustment variant | Has no signed attributes → verification fails → **left at the adjustment variant's own native price**. The Transform does **not** block it. Fail-**open-ish** (depends entirely on the variant being hidden/unpurchasable + a Validation rule). |
| Time usage | **YES — defect.** `cartTransformRun` calls `Math.floor(Date.now() / 1000)` and `runCartTransform` checks `now > payload.expiresAt` (`expired`). Constraint #8 forbids clock use in Functions; Shopify's runtime makes `Date.now()` unreliable/frozen. Tests inject a fixed `now`, masking it. |
| Compiled secret | `config.generated.ts` → `CART_SIGNING_SECRET = ""` — **EMPTY** (checked-in placeholder). Fails closed. Real value baked at build time by `scripts/generate-config.mjs` from `IMPRINTID_CART_SIGNING_SECRET`. |
| Server env today | No `.env` file present; `IMPRINTID_CART_SIGNING_SECRET` and `IMPRINTID_ADJUSTMENT_VARIANT_ID` are unset → `buildSignedCartPricingIfRequested` returns `null` → **no quote is ever produced**. End-to-end signing is currently fully inert. |
| Canonicalization/HMAC duplication | **YES, intentional.** `extensions/…/src/hmac-sha256.ts` is a byte-for-byte copy of `app/lib/pricing-api/hmac-sha256.ts`; `verify-payload.ts#canonicalize` mirrors `cart-signature.ts#canonicalizeCartPricingPayload`. Function builds can't import outside the extension dir. **No shared golden fixture** pins the pair — each side has independent known-answer tests only → semantic-drift risk. |
| Supported surfaces (this Function) | Runs wherever Cart Transform runs: Cart, Checkout, Storefront, Storefront Accelerated Checkout, Draft Orders, B2B, Admin. **Not** Create Order API, Order Edit, Pre-order/TBYB, Subscriptions. `lineExpand` is **rejected when a selling plan is present**. POS only with `requiresComponents`. |

### 2.2 Server signing path

`storefront-handler.ts#buildSignedCartPricingIfRequested` → `cart-signature.ts#buildCartPricingPayload`
(decomposes `PricingCalculationResult` into base/per-unit/flat, TTL = 30 min) →
`signCartPricingPayload` (canonical sorted `key=value\n`, HMAC-SHA256). Secret validated by
`validateSigningSecret` (rejects blank / whitespace-padded, no trim). Adjustment variant validated
by `validateAdjustmentVariantGid` (full `gid://shopify/ProductVariant/<n>` only). Currency read from
`pricingProfile.currency` (default `"USD"`).

### 2.3 Test coverage (existing)

| Suite | test() count |
|---|---|
| `extensions/…/src/cart_transform_run.test.ts` | 22 |
| `extensions/…/src/verify-payload.test.ts` | 19 |
| `extensions/…/src/hmac-sha256.test.ts` | 2 |
| `app/lib/pricing-api/cart-signature.test.ts` | 7 |
| `app/lib/pricing-api/hmac-sha256.test.ts` | 7 |
| `app/lib/pricing-api/storefront-handler.test.ts` | 39 |

Covered: missing/invalid/tampered signature, unsupported version, malformed JSON, negative price,
quantity mismatch, variant replay, expiry, wrong secret, exact-total reconstruction, multi-line
carts, presentment-rate conversion. **Not covered:** product-GID binding, profile-revision binding,
config-digest binding, currency enforcement, direct adjustment-variant add, universal-mode
fail-closed, any Validation Function (none exists), cross-runtime golden vectors.

### 2.4 Task 4A.5 (native-button containment)

**Not present in the repository.** No file, test, or doc references "4A.5". `dynamic-pricing.js`
carries Task 2B/4A Add-to-Cart *quote-ownership* guards (disable when `cartPricing` is null / the
selected variant≠quoted variant/product), but no dedicated 4A.5 native-purchase-path containment.
Recorded as a **prerequisite for live storefront approval**, not a blocker for this analysis.

---

## 3. Shopify plan / distribution feasibility matrix

Official sources (fetched this task): `functions/latest`, `functions/latest/cart-transform`,
`functions/latest/cart-and-checkout-validation`, `apps/build/checkout/cart-checkout-validation/create-checkout-validation`.

Confirmed constraints:

| # | Constraint | Verdict | Evidence |
|---|---|---|---|
| 1 | Cart & Checkout Validation is Shopify's server-side cart/checkout validation mechanism | **Confirmed** | validation API ref |
| 2 | Validation supports Cart, Storefront, Checkout, Storefront Accelerated Checkout | **Confirmed** | validation API ref "Supported" surface table (also B2B, Draft Order, Admin) |
| 3 | Cart Transform executes **before** Validation | **Confirmed** | functions overview pipeline: (1) Cart lines → … → (7) Verification (Cart & Checkout Validation) |
| 4 | Cart Transform `lineUpdate` price overrides restricted to dev stores / Shopify Plus | **Confirmed verbatim** | cart-transform: *"Only development stores or stores on a Shopify Plus plan can use apps with `update` operations."* |
| 5 | Any-plan stores can use Functions via eligible **public App Store** apps | **Confirmed** | functions overview: custom-app restriction "applies only to custom apps"; public App Store apps with functions usable on all plans |
| 6 | Custom apps containing Shopify Functions require Shopify Plus | **Confirmed verbatim** | functions overview: *"Only stores on a Shopify Plus plan can use custom apps that contain Shopify Function APIs."* |
| 7 | Function run targets cannot call the app DB or pricing API | **Confirmed** | functions overview: run targets have no network; the `fetch` target is *"limited to custom apps installed on Enterprise stores"* and unavailable on dev stores |
| 8 | Function logic must be deterministic; no clock | **Confirmed verbatim** | functions overview: *"you can't use any randomizing or clock functionality in your functions."* |
| 9 | Enforcement policy must come from Shopify-owned data (app-owned metafields), not customer line properties | **Confirmed** | validation guidance: input via metafields on queried resources; customer attributes are untrusted |

**Ambiguity — `lineExpand` plan gate:** current cart-transform doc restricts only `update`. No
restriction text was found for `lineExpand`/`linesMerge` on any fetched page. The repo code comment
claims the opposite from an earlier reading. **Treated as UNVERIFIED** because a *price-adjusting*
expand ≠ a plain bundle expand, and Shopify's price-control gating historically follows "does the
customer pay a different amount".

### Decision table

| Environment | Cart Transform `lineExpand` (+price adj.) | Validation Function `cart.validations.generate.run` | Net: can dynamic pricing be **enforced**? |
|---|---|---|---|
| **Development store** | Works (current) | Works | Yes — but proves nothing about production (Task §3). |
| **Basic production + custom-distributed app** | **NO** — constraint #6 blocks *all* Functions in a custom app on non-Plus | **NO** — same | **BLOCKED. Release blocker.** |
| **Basic production + eligible public App Store app** | **CONDITIONAL** — current docs indicate `lineExpand` (incl. price adjustment) is available; **pending written Shopify confirmation + a test on a real Basic production store** (D3). | **Yes** — Validation runs on all plans via public apps | **Conditionally yes.** If the Transform confirmation is positive: full enforcement (Transform prices, Validation blocks). If negative: Validation still *blocks* non-compliant carts, and correct pricing needs an alternative mechanism (§14 O-2). |
| **Shopify Plus production + custom app** | Works | Works | **Yes.** |
| **Shopify Plus production + public app** | Works | Works | **Yes.** |

**Selling-plan / subscription:** `lineExpand`, `linesMerge`, `lineUpdate` are **rejected when a
selling plan is present**; subscriptions/recurring orders unsupported. ImprintID has no selling-plan
model today — becomes a hard constraint the moment a configured product is sold on a selling plan.

**POS:** Cart Transform partially supported (needs `ProductVariant.requiresComponents = true`);
Validation **not supported on POS**. Enforced products should be flagged POS-ineligible or sold POS
at a controlled fallback.

**Draft Order / Create Order API / Order editing:** Cart Transform supports Draft Orders but **not**
Create Order API or Order Edit; Validation supports Draft Order (Admin + Checkout) but **not** Order
Edit or Create Order API. Quotes created through Draft Orders / the Order API / order edits are
**outside both enforcement layers** — staff-created orders must use an internal quoting tool that
reuses the same server pricing engine.

**Required final distribution model:** **Public app distribution** (App Store listed, or a public
but unlisted distribution). Custom distribution is only viable if every target merchant is
contractually Shopify Plus.

---

## 4. Trust boundaries

| Zone | Trusted for | NOT trusted for |
|---|---|---|
| **App server** (`app/lib/pricing/*`, `storefront-handler.ts`) | Price calculation; minting + signing quotes; reading DB; owning the signing secret | — (this is the root of trust) |
| **Signing secret** `IMPRINTID_CART_SIGNING_SECRET` | Proving a quote came from the server | Must never be in client JS, theme assets, logs, or the OAuth-secret slot. Baked into the Function WASM at build time only. |
| **App-owned metafields** (shop + product) | *Whether* enforcement applies; adjustment-variant identity; profile/policy revisions | Merchant-editable metafields would break this — must be `app-owned` definitions. |
| **Cart Transform Function** | Verifying a signature and applying the *already-signed* numbers | Calculating a price; reading the DB; the clock; deciding policy from line properties |
| **Validation Function** | Independently re-verifying the signature + identity + revision; blocking the cart | Same exclusions as Transform |
| **Storefront JS** (`dynamic-pricing.js`) | UX: guiding config, requesting a quote, submitting it, disabling *unrelated* native buttons | **Nothing security-relevant.** Button disabling is cosmetic. Line properties it writes are attacker-controlled. |
| **Cart line attributes** (`_imprintid_pricing_*`) | Carrying an opaque signed blob for the Functions to verify | Their *contents* until the signature verifies. The customer can set them to anything. |
| **Shopify edge (App Proxy HMAC)** | Authenticating which shop a storefront pricing request is for | — |

**Core principle:** the browser is never the security boundary. Every enforced outcome is decided
by a Function re-verifying a server signature against Shopify-owned data.

---

## 5. Threat model

Legend — **Transform**: what `cart.transform.run` does. **Validation**: what the future
`cart.validations.generate.run` does. **Class**: fail-**closed** (customer blocked / cannot
underpay) or fail-**safe** (no transform, native price, not necessarily blocked) or fail-**open**
(customer can underpay).

| # | Threat | Authoritative evidence | Transform | Validation (designed) | Customer-visible | Class |
|---|---|---|---|---|---|---|
| 1 | Native theme Add to Cart (no quote) on an enforced product | product policy metafield `required=true`; line has no `_imprintid_pricing_*` | no-op (native price) | **block cart**: enforced product without a valid quote | "This item must be configured before checkout." | **closed** (with Validation) / open (Transform-only) |
| 2 | Direct `/cart/add.js` with no quote | same | no-op | **block** | same as #1 | **closed** |
| 3 | Storefront API `cartLinesAdd` with no quote | Validation runs on Storefront surface (#2 confirmed) | no-op | **block** | cart mutation returns validation error | **closed** |
| 4 | Accelerated checkout (Shop Pay / Apple Pay) bypassing the PDP | Validation supports Storefront Accelerated Checkout | n/a | **block** at checkout | cannot complete accelerated checkout | **closed** |
| 5 | Signed properties missing on an enforced line | as #1 | `missing_attributes` → no-op | **block** | as #1 | **closed** |
| 6 | Signed properties present but modified (any field) | HMAC over canonical string | `invalid_signature`/`malformed_payload` → no-op | signature re-check fails → **block** | as #1 | **closed** |
| 7 | Valid signature minted for **another product** | v1: product not bound. v2: `productGid` bound; Validation compares to line product | v1: applied if variant happens to match; v2: `product_mismatch` | v2: **block** on `productGid ≠ line.product.id` | v2: blocked | v1 **OPEN** → v2 **closed** |
| 8 | Valid signature for **another variant** | `baseVariantId` bound + checked | `variant_mismatch` → no-op | **block** on variant≠signed | blocked | **closed** |
| 9 | Valid signature for **another quantity** | `quantity` bound + exact-match | `quantity_mismatch` → no-op | **block** on qty≠signed | blocked | **closed** |
| 10 | Cart quantity edited **after** add | line qty now ≠ signed qty | `quantity_mismatch` → **reverts to native price** | **block**: signed qty ≠ current qty | "Re-configure to change quantity." | Transform **fail-safe→leak**; **closed** only with Validation |
| 11 | Currency / market changed between quote and checkout | `currency` bound; cart presentment currency available to Validation | applies `presentmentCurrencyRate` blindly (no currency check) | **block** on `signed.currency ≠ cart.currency` (unless a signed FX policy exists) | "Prices changed for your region — re-configure." | v1 **OPEN-ish**; **closed** with Validation currency check |
| 12 | Old signed quote replayed after a price change | v2: `profileRevision`/`policyRevision` bound; Validation reads current revision from product metafield | v1: still applied (clock-based expiry unreliable). v2: revision mismatch → no-op | v2: **block** on stale revision | "This quote is no longer valid." | v1 **OPEN**; v2 **closed** |
| 13 | Duplicate signed lines (same quote added N times) | each line independently valid | each expanded correctly | allowed (each line priced correctly) | N correctly-priced lines | **safe** (no financial loss) |
| 14 | Mixed enforced + unenforced products in one cart | per-line policy metafield; Function iterates lines independently | only enforced lines transformed | only enforced lines validated | unenforced lines unaffected | **safe** |
| 15 | Unavailable / archived variant | `productVariant.availableForSale` in Validation input query | verifies (Transform doesn't check availability) | **block** enforced line whose variant is unavailable | "This variant is unavailable." | **closed** |
| 16 | Direct add of the **adjustment variant** | shop policy metafield `adjustmentVariantGid`; product `role=adjustment` metafield | no-op (adjustment variant's native price) | **block** any cart containing the adjustment variant as a *customer* line (only the Transform may introduce it) | "This item can't be added directly." | Transform **OPEN**; **closed** with Validation + variant hidden/`unavailable` |
| 17 | Signed line properties copied onto a **different merchandise id** | `baseVariantId` bound; v2 also `productGid` | `variant_mismatch` → no-op | **block** | blocked | **closed** |
| 18 | Missing / malformed enforcement metafield on a product | Validation input query returns `null` metafield | no-op | **`pilot`**: ignore (not enforced). **`universal`**: **block** (fail closed) | universal: "Pricing policy unavailable — contact us." | mode-dependent, **closed in universal** |
| 19 | Function runtime exception | Shopify's per-validation checkout-exception setting | Shopify falls back per Transform's own failure semantics (line untransformed) | with **"Allow all customers to submit checkout" DESELECTED**, Shopify's docs describe checkout being blocked on a Function runtime exception. Its exact effect on every non-checkout surface (theme AJAX cart, Storefront API) is not documented and must be confirmed by live testing. | "We couldn't verify pricing. Try again." | **closed at checkout** when the setting is configured; other surfaces **to be verified** (see §9) |
| 20 | App / pricing API down **after** a quote was issued | quote already signed; Functions never call the app | quote still verifies & applies (Functions are self-contained — this is a feature) | quote still validates; block only if revision can't be read → then universal-mode fail-closed | customer with a fresh valid quote checks out fine | **safe** (by design) |

**Residual risks after v2:** (a) a quote replayed *before* any revision bump, within its TTL — still
honored, but **at the correct price for an unchanged config**, so no loss; (b) price edits that fail
to bump `profileRevision` (operational discipline / webhook reliability); (c) FX drift between quote
and checkout on multi-currency stores if no signed FX rule; (d) staff orders via Draft Order / Order
API / order edits — outside both Functions entirely.

---

## 6. Metafield policy contract (app-owned)

All definitions created with **`ownerType`-scoped, app-owned** metafield definitions
(`access: { admin: MERCHANT_READ }`, app read/write) so merchants cannot edit policy and customers
never see it on line items. Namespace: the app-reserved `$app:imprintid` (resolves to
`app--<app-id>--imprintid`). **No metafields are written in Task 5A.**

### A. Shop-level — `$app:imprintid` / `enforcement_policy` (type `json`)

```jsonc
{
  "schema": 1,
  "mode": "disabled" | "pilot" | "universal" | "maintenance",
  "enabled": true,
  "adjustmentVariantGid": "gid://shopify/ProductVariant/<n>",
  "installBinding": "<opaque per-install value set at install time>",
  "policyRevision": 7            // monotonic; bump on ANY policy change
}
```

| Field | Security purpose |
|---|---|
| `schema` | Guards canonicalization / parsing across contract versions |
| `mode` | Enforcement mode — see the table below. The four modes are `disabled`, `pilot`, `universal`, `maintenance`. |
| `enabled` | Hard kill switch independent of `mode` — `false` short-circuits the Transform to "no operations" without losing the configured mode. |
| `adjustmentVariantGid` | Canonical identity of the adjustment variant for both Functions; the signed payload's `adjustmentVariantGid` is cross-checked against **this**, never trusted on its own |
| `installBinding` | Opaque per-install value the app sets at install time. Binds a signed quote to one install — the Function has no `Shop.id` (verified against the `2026-07` schema), so it compares `payload.installBinding` to this metafield value instead. App-owned ⇒ merchant-uneditable ⇒ authoritative. |
| `policyRevision` | Deterministic global quote-invalidation lever (no clock needed) |

**Enforcement modes:**

| `mode` | Cart Transform | Validation Function (future) | Native-price fallback for enforced products? |
|---|---|---|---|
| `disabled` | emits **no** enforcement operation | inactive | Yes — but only through **documented business authorization**; dynamic enforcement is intentionally off |
| `pilot` | prices only products with an active `required=true` policy | blocks only those products when their quote is invalid | Non-marked products: yes (they aren't in scope). Marked products: no |
| `universal` | every ordinary product requires an active policy + valid quote to be priced | blocks any ordinary product lacking an active policy or a valid quote | No |
| `maintenance` | **emits no pricing operation for enforced products** | **blocks enforced products from cart/checkout** | **No** — enforced products are blocked, not sold at native price. This is the **secure technical rollback** during a pricing incident. |

### B. Product-level — `$app:imprintid` / `pricing_policy` (type `json`)

```jsonc
{
  "schema": 1,
  "required": true,
  "profileRef": "prof_LNY01",       // stable pricing-profile / override key (NOT a DB row id)
  "profileRevision": 12,            // bump whenever the profile's pricing inputs change
  "active": true,
  "policyRevision": 7               // echoes shop revision at last sync; reconciliation aid
}
```

| Field | Security purpose |
|---|---|
| `required` | Whether this product must carry a valid quote |
| `profileRef` | Binds the product to a specific pricing profile / override; the signed quote must carry the same `profileRef` |
| `profileRevision` | Deterministic per-product quote-invalidation: bumped on any pricing change → all older quotes fail the Validation revision check |
| `active` | A profile pulled offline → `active:false` → in `universal` mode the product is blocked (fail closed), never sold at native price |
| `policyRevision` | Detects products that missed a sync pass (reconciliation) |

### C. Adjustment-variant marker — product-level `$app:imprintid` / `role` (type `single_line_text_field`, value `"adjustment"`)

- The adjustment product/variant is **authoritatively identifiable** by this metafield **and** by
  matching the shop policy's `adjustmentVariantGid`. Both Functions take its identity from the shop
  policy metafield — never from the customer-supplied payload (the payload's `adjustmentVariantGid`
  is *cross-checked against* the metafield, not trusted).
- It is **exempt** from ordinary "enforced product needs a quote" validation (it legitimately has no
  quote), **but** any cart that contains it as a *customer-added* line is **blocked** by the future
  Validation Function.
- **Do NOT rely on marking the adjustment variant "unavailable for sale."** Current Shopify
  documentation does not establish that an unavailable variant remains usable as a `lineExpand`
  component, and the Transform must be able to reference it. The secure design is instead:
  (1) the authoritative `role` + shop-policy GID checks above; (2) storefront hiding where safe
  (remove it from collections / nav / search, no theme surface links to it); (3) direct-add
  rejection by the Validation Function; (4) exact adjustment-variant identity checks in both
  Functions. If a controlled test later proves an unavailable variant still expands, hiding it can
  be tightened then — it is not a prerequisite.

### Universal-mode "no product policy metafield" rule

| `mode` | Ordinary product, no valid `pricing_policy` metafield |
|---|---|
| `disabled` | Sold at native price (no enforcement anywhere) |
| `pilot` | Sold at native price (only explicitly-marked products are enforced) |
| `universal` | **Blocked at cart/checkout** (deliberate fail-closed) with a customer-safe message |

### Scale properties

- **No hard-coded product-ID list** anywhere in a Function. Each Function's input query pulls the
  policy metafield for *the products actually in the cart* — applicability is automatic and per-line.
- Idempotent sync: `metafieldsSet` is upsert-by-(owner, namespace, key); re-running a batch is a
  no-op when values are unchanged (compare-then-write).
- Reconciliation: `products/update` and `products/delete` webhooks + a scheduled full sweep
  re-derive each product's policy from the pricing DB and bump `profileRevision` on drift.

---

## 7. Signed-quote contract (envelope v2 — design; v1 unchanged in Task 5A)

Every field has a stated security purpose; nothing decorative.

```jsonc
{
  "v": 2,
  "shopId": "gid://shopify/Shop/<n>",          // quote is valid for exactly one shop (multi-tenant replay)
  "productGid": "gid://shopify/Product/<n>",   // closes threat #7 / #17; Validation compares to line.product
  "variantGid": "gid://shopify/ProductVariant/<n>",  // closes threat #8; == line.merchandise.id
  "quantity": 100,                              // closes threats #9 / #10; exact match
  "currency": "USD",                            // closes threat #11; == cart presentment currency
  "unitAmountCents": 137,                       // net base unit price to apply
  "perUnitSurchargeCents": 0,                   // exact per-unit surcharge component
  "flatSurchargeCents": 4500,                   // exact one-time surcharge component
  "lineTotalCents": 18200,                      // integrity cross-check: base*q + perUnit*q + flat
  "adjustmentVariantGid": "gid://shopify/ProductVariant/<n>",  // must equal shop policy value
  "profileRef": "prof_LNY01",                   // binds to a pricing profile (threat #12)
  "profileRevision": 12,                        // deterministic replay/expiry (no clock)
  "policyRevision": 7,                          // invalidates on enforcement-policy change
  "configDigest": "sha256:…",                   // SHA-256 of normalized selected configuration (threat: cheap quote / expensive job)
  "quoteId": "q_01J…",                          // audit identity ONLY — a Function has no DB to check it against; no Function-side replay ledger
  "issuedAtServer": 1725000000                  // ADVISORY ONLY — used by the APP pre-add, never by a Function clock check
}
// signature = HMAC-SHA256( secret, canonical(payload) )   — NOT part of canonical()
```

Transport (unchanged shape, three line attributes):

| Attribute | Contents |
|---|---|
| `_imprintid_pricing_version` | `"2"` |
| `_imprintid_pricing_payload` | `JSON.stringify(payload)` |
| `_imprintid_pricing_signature` | lowercase hex HMAC-SHA256 of `canonical(payload)` |
| `_imprintid_pricing_config` | normalized configuration JSON — the Function hashes this and compares to `configDigest` (so a tampered config attribute fails the digest, and the human-readable production config can't drift from the priced one) |

**Canonical form:** sorted `key=value` joined with `\n` (unchanged from v1 — the one serialization
spec both runtimes implement).

### Replay / expiry **without a Function clock**

| Mechanism | How | Residual risk |
|---|---|---|
| **Revision-bound (primary)** | Quote carries `profileRevision` + `policyRevision`. Validation Function's input query pulls the *current* values from the product + shop metafields. Mismatch → fail closed. Deterministic, no clock. | A quote replayed *before* any revision bump is honored — but at the correct price for that (unchanged) profile/config, so no financial loss. |
| **App-side short TTL (secondary)** | The **app**, before returning a quote and (optionally) at an authenticated "prepare add-to-cart" step, rejects quotes older than `issuedAtServer + TTL`. The app has a real clock. | Only helps for flows that round-trip the app; a pure client replay to `/cart/add.js` skips it. |
| **Config digest** | `configDigest` binds price ↔ exact configuration; `_imprintid_pricing_config` must hash to it. | none material |
| **Nonce / quoteId** | Enables server-side "issued quotes" ledger + future async reconciliation ("was this quote ever issued for this shop?"). Cannot be enforced *inside* a Function (no callback). | in-Function dedup limited to "same quoteId twice in one cart" |
| **Policy-revision invalidation** | Any enforcement change (mode, adjustment variant, profile) bumps `policyRevision` → every outstanding quote fails closed at next validation. | webhook/sync latency window |

**Do NOT** put `Date.now()` in either Function. The current Transform's `expired` check must be
**removed** and replaced by the revision check (tracked as blocker B-3 / Task 5B).

---

## 8. Cart Transform responsibilities

1. For each cart line, read: `id`, `quantity`, `merchandise.id`, the four `_imprintid_pricing_*`
   attributes, `product.id`, and the product's `$app:imprintid/pricing_policy` +
   `$app:imprintid/role` metafields, plus the shop `enforcement_policy` metafield.
2. Identify an **enforced** line: `enforcement_policy.enabled && mode ≠ disabled` **and**
   (`pricing_policy.required && pricing_policy.active`, or — in `universal` mode — any ordinary
   product).
3. Parse + structurally validate the payload; **fail-closed parse** (any shape error → no-op).
4. Verify HMAC-SHA256 over the canonical string, constant-time.
5. Verify ownership: `productGid == line.product.id`, `variantGid == line.merchandise.id`,
   `quantity == line.quantity`, `currency == cart.presentmentCurrency`,
   `adjustmentVariantGid == enforcement_policy.adjustmentVariantGid`,
   `profileRef == pricing_policy.profileRef`, `profileRevision == pricing_policy.profileRevision`,
   `policyRevision == enforcement_policy.policyRevision`,
   `sha256(_imprintid_pricing_config) == configDigest`,
   `base*q + perUnit*q + flat == lineTotalCents`.
6. On **any** failure → **no operation for that line** (never guess, never partially apply).
7. On success → emit exactly one `lineExpand` decomposing base (real variant) + per-unit surcharge
   (adjustment variant × q) + flat surcharge (adjustment variant × 1), each
   `price.adjustment.fixedPricePerUnit` in presentment currency via `presentmentCurrencyRate`
   (exact-integer path when rate is `"1"`).
8. **Adjustment variant protection:** never emit an operation for a *customer* line whose merchandise
   is the adjustment variant; only the Transform itself may introduce it as an expanded component.
9. Never trust a browser-supplied total without a verified signature. There is no "trusted total"
   input — the only number applied is the one inside a verified payload.

**Production-plan behavior of `lineExpand` price adjustment:** works on dev stores and (confirmed)
Shopify Plus. **Not confirmed for Basic** even via a public app (D3 / §14 O-2). **If the target
production store is Basic and the confirmation is negative, this Transform strategy is not usable in
production and the pricing mechanism must change** (bespoke priced variant per config-hash, or a
Draft-Order checkout for non-Plus merchants) — stated plainly, not worked around.

---

## 9. Validation Function responsibilities (`cart.validations.generate.run`)

A **future** Function (Task 5B). Independent of the Transform — it re-derives everything from the
same signature + Shopify-owned data and **fails closed**.

Input query (per line): `merchandise { … on ProductVariant { id availableForSale product { id } } }`,
`quantity`, the four `_imprintid_pricing_*` attributes, product
`$app:imprintid/pricing_policy` + `role` metafields, shop `enforcement_policy` metafield, cart
`cost.totalAmount.currencyCode`, and (where the schema exposes it) the line's computed cost for the
inconsistency cross-check.

Emit a validation error (fail closed) for an enforced line when **any** of:

| Condition | Message (customer-safe, no security detail) |
|---|---|
| quote envelope missing | "Configure this item before checking out." |
| parse fails / unsupported version | same |
| signature verification fails | same |
| `productGid` / `variantGid` / `quantity` ≠ line | "Your selection changed — please re-configure." |
| `currency` ≠ cart presentment currency | "Pricing changed for your region — re-configure." |
| `profileRevision` ≠ current product metafield / `policyRevision` ≠ current shop metafield | "This quote is no longer valid — re-configure." |
| `configDigest` ≠ `sha256(_imprintid_pricing_config)` | "Your configuration changed — re-configure." |
| computed line cost inconsistent with `lineTotalCents` (where schema permits) | "We couldn't verify this price — re-configure." |
| the adjustment variant appears as a customer line | "This item can't be added on its own." |
| `mode = universal` and an ordinary product line has no valid, active `pricing_policy` | "This product isn't available for purchase right now." |

**Approved default validation target: `$.cart`.** A cart-level error is guaranteed to block
checkout on every supported surface. Line-specific targeting (`$.cart.lines[<index>]` or similar)
is used **only if** the generated `2026-07` validation schema and official documentation prove a
supported line-level target path (open decision O-6); until then, all validation errors target
`$.cart`. Never reveal *why* beyond the generic customer-safe copy.

**Behavior by surface:**

| Surface | Behavior |
|---|---|
| Cart interaction (theme cart / AJAX) | error surfaced on the cart; checkout button gated by theme; Storefront `cart.errors` populated |
| Checkout interaction | error shown on checkout; customer cannot advance |
| Checkout completion | Shopify re-runs validation at completion → a cart that mutated post-load is re-checked |
| Accelerated checkout (Shop Pay / Apple Pay / Google Pay) | validation runs (surface #2 confirmed) → blocked before payment authorization |
| Storefront API `cartLinesAdd` / `cartLinesUpdate` | mutation returns `userErrors` / `cart.errors`; no valid checkout URL until resolved |

**Exception-handling activation setting (DO NOT ACTIVATE in 5A / 5B.1):** in the Shopify admin, on
the activated validation, **deselect "Allow all customers to submit checkout"**. Shopify's docs
describe this as controlling checkout behaviour when the Function hits a runtime exception —
deselected, the customer cannot submit checkout. This is the toggle that makes a runtime *exception*
fail-closed **at checkout** (threat #19). It is **not** established that it blocks every theme
AJAX-cart interaction or Storefront API mutation on a Function exception — that must be verified with
live tests during the pilot. Document it in the runbook; activation happens only at go-live.

---

## 10. Client-side responsibilities (defense in depth only)

The browser MUST:
- guide the customer through configuration;
- request a server-calculated quote (`POST /apps/imprintid-pricing/pricing`);
- submit the signed quote + normalized config as the four line attributes on add-to-cart;
- disable *unrelated* native purchase paths **only where safely scoped** to the enforced product
  (native Add to Cart, Buy Now, dynamic checkout buttons on that PDP) — Task 4A.5;
- display useful, non-sensitive errors.

The browser MUST NOT be treated as the security boundary. Every bullet above is convenience or UX;
the Functions are the enforcement. Task 4A.5 containment is kept as **defense in depth**, reducing
accidental native adds — not as a control.

---

## 11. Rollout plan for 6,500+ products

| Stage | Entry criteria | Actions | Exit criteria |
|---|---|---|---|
| **0. Contract freeze** | this doc approved | Publish envelope v2 + property/serialization spec + golden vectors; wire the config digest + revisions server-side (no metafield writes) | vectors green on both runtimes |
| **1. LNY01 pilot** | secret + adjustment variant configured; Validation Function built (not activated); D3 confirmation obtained | `mode = pilot`; write `pricing_policy` for LNY01 only; adjustment variant hidden/unavailable; activate Transform + Validation on a **dev/staging** store | 2 weeks, zero mispriced orders, zero false blocks, all threat cases (§5) reproduced & blocked |
| **2. Internal cohort** | pilot exit met | 20–50 representative products (varied decoration/option shapes); idempotent bulk sync in **dry-run** then apply | coverage report = 100 % of cohort; exception report empty |
| **3. Catalog batch migration** | cohort stable 1 week | Resumable batches of ≤250 products (cursor-paginated), `metafieldsSet` ≤25/call, throttled to bulk-op limits; dry-run diff per batch; per-batch coverage + exception counts persisted | every product either has an active `pricing_policy` or is on an explicit exclusion list; reconciliation sweep clean |
| **4. Reconciliation audit** | migration "complete" | Full sweep: for every product, compare metafield `profileRef/profileRevision/active` to the pricing DB; `products/update` + `products/delete` webhooks live; scheduled nightly re-sweep | drift = 0 for 3 consecutive nights |
| **5. Universal enforcement** | audit clean; go/no-go sign-off | Flip shop `mode = universal` (bumps `policyRevision` → invalidates all outstanding quotes); monitor block rate + support volume | block rate returns to baseline within 24 h; no revenue anomaly |
| **6. Rollback / emergency stop** | any SEV | **Pricing incident (a wrong price could be charged): set `mode = maintenance`** (single metafield write, effective next Function run) → enforced products are **blocked** from cart/checkout, never sold at a possibly-wrong native price. **Enforcement-infra incident (Function/keys broken, no pricing risk) and a deliberate business decision to fall back:** `mode = disabled` (native pricing allowed only under documented authorization) or step back to `pilot`. `enabled = false` is the hard kill switch. Valid in-flight carts with a correctly-signed quote are not stranded by `disabled`/`pilot`; `maintenance` intentionally blocks them until resolved. | incident contained; RCA before leaving `maintenance` |

**Bulk sync properties:** idempotent (compare-then-write), cursor-resumable (persist last product
cursor + batch index), dry-run mode (emits the would-write diff + coverage/exception counts, writes
nothing), throttled to Admin API cost limits, exception report per product (missing profile,
inactive profile, variant issues), coverage counts (`products total / with active policy / required
/ excluded`). Rollback never deletes `pricing_policy` metafields (so re-enable is instant) — it only
flips the shop-level switch.

**Explicit go/no-go for universal mode:** (a) §14 blockers all cleared; (b) ≥ 4 weeks stable pilot +
batches; (c) reconciliation drift = 0 for 3 nights; (d) documented rollback rehearsed on staging;
(e) support + fulfilment sign-off; (f) D3 confirmation on file for the production plan + distribution.

---

## 12. Failure & rollback behavior

| Failure | Effect | Recovery |
|---|---|---|
| Signing secret mismatch (app vs Function) | every quote fails verification → enforced lines blocked (universal) or unpriced (pilot) | regenerate `config.generated.ts` from the same secret; redeploy Function; the app secret is the source of truth |
| Function exception / timeout | with the block-on-exception setting: checkout blocked | fix + redeploy; setting is intentional fail-closed |
| Webhook missed → stale `profileRevision` | quotes for that product may validate against an old revision, OR (if bumped) all fail closed | nightly reconciliation sweep re-bumps; manual re-sync command |
| `lineExpand` unavailable on production plan (D3 negative) | Transform silently no-ops in production; Validation still blocks bad carts, but *correct* pricing never lands → every enforced cart blocked | **release blocker** — switch pricing mechanism (bespoke variant / draft order) before go-live |
| Pricing incident (wrong price possible) | `mode=maintenance` → enforced products blocked from cart/checkout, **no native-price fallback** | single metafield write; the secure rollback; leave `maintenance` only after RCA |
| Enforcement-infra incident, no pricing risk, business-authorized fallback | `mode=disabled` (or `pilot`, or `enabled=false`) → enforced products revert to native price under documented authorization | single metafield write; in-flight valid quotes still honoured |
| Adjustment variant deleted / archived | Transform's expanded components reference a dead variant → operation rejected by Shopify → enforced lines unpriced | Validation blocks (adjustment GID mismatch); restore variant or update shop policy + bump `policyRevision` |

---

## 13. Test strategy

| Layer | Tests | Runner |
|---|---|---|
| Serialization contract | golden-vector file `docs/architecture/fixtures/signed-quote-vectors.json` (or `app/lib/pricing-api/__fixtures__/`): `{secret, payload, canonicalString, signatureHex}` for v1 **and** v2; asserted by **both** `cart-signature.test.ts` (server) and `verify-payload.test.ts` (Function) so drift fails CI | `node --test` |
| Server signing | existing 7 + new: product-GID bound, `profileRef`/`profileRevision` bound, `configDigest` computed from normalized config, currency bound, v2 canonical stability | `node --test` |
| Transform | existing 22 + new: product mismatch, revision mismatch, config-digest mismatch, currency mismatch, adjustment-variant-as-customer-line, **`Date.now()` removed** (no clock path) | `node --test` (WASM unit via `shopify app function run` at build time) |
| Validation (5B) | new suite: every §9 fail-closed condition; universal-mode no-policy block; pilot-mode ignore; line-level vs cart-level targeting; message contains no security detail | `node --test` + `shopify app function run` |
| Metafield sync (5B) | idempotency (second run = no writes), dry-run writes nothing, resume from cursor, coverage/exception counts, webhook-driven revision bump | `node --test` against a mocked Admin client |
| POC (this task) | see §"POC" below — pure, non-production | `node --test` |

**POC added in Task 5A** (`app/lib/pricing-api/enforcement-envelope.poc.test.ts`, non-production,
no imports into shipping code): demonstrates (a) a v2-style canonical string is stable under key
reordering; (b) a config digest over a normalized config object detects a changed option id;
(c) a revision-mismatch check is a pure function of two integers (no clock). These are illustrative
vectors for Task 5B, not a shipping module.

---

## 14. Open decisions

| ID | Decision needed | Owner | Blocks |
|---|---|---|---|
| O-1 | Final distribution: public App Store app (unlisted vs listed) vs. Plus-only custom app | Product / Shopify Partnerships | everything |
| O-2 | **Written Shopify confirmation**: is a Cart Transform `lineExpand` with `price.adjustment.fixedPricePerUnit` available on the *production* plan + distribution model we choose (esp. Basic via public app)? If not — bespoke priced variant per config-hash, or Draft-Order checkout for non-Plus? | Shopify Partner support | pricing mechanism |
| O-3 | `profileRef` scheme — stable string key vs. `gid` for a future "PricingProfile" metaobject | Eng | envelope v2, sync |
| O-4 | Config normalization spec (field order, enum casing, null handling) — must be byte-identical server + Function | Eng | `configDigest` |
| O-5 | Multi-currency: sign a single presentment currency per quote (block on market change) vs. sign a per-market price table | Eng / Finance | threat #11 |
| O-6 | Does the pinned `2026-07` validation schema support per-line error targeting, or cart-level only? | Eng (schema fetch) | §9 UX |
| O-7 | Adjustment variant: one shared variant vs. one per shop vs. per pricing profile (reporting granularity) | Eng / Ops | §6C |
| O-8 | Reconciliation cadence + webhook set (`products/update`, `products/delete`, bulk operations finish) | Eng | stage 4 |

## 15. Release blockers

| ID | Blocker | Exit |
|---|---|---|
| **B-1** | Custom-distributed app cannot run Functions on non-Plus (constraint #6). Current app is custom-distributed. | Move to public app distribution (O-1). |
| **B-2** | `lineExpand` price-adjustment plan eligibility for production is unverified (D3 / O-2). | Written confirmation from Shopify, or a confirmed alternative pricing mechanism. |
| **B-3** | Cart Transform uses `Date.now()` (constraint #8 violation; unreliable in the Function runtime). | Remove clock-based expiry; replace with revision-bound invalidation (§7). |
| **B-4** | Signed envelope does not bind product GID, pricing-profile identity/revision, or configuration digest (threats #7, #12, cheap-quote/expensive-job). | Ship envelope v2 + Function checks (Task 5B). |
| **B-5** | No Validation Function exists. Transform-only leaves threats #1–4, #10, #16, #18 open. | Build + activate `cart.validations.generate.run` (Task 5B) with block-on-exception. |
| **B-6** | No enforcement metafield contract deployed; policy currently implicit. | Create app-owned definitions + sync (Task 5B/5C). |
| **B-7** | Signing not configured: `CART_SIGNING_SECRET = ""`, `IMPRINTID_ADJUSTMENT_VARIANT_ID` unset, no `.env`. End-to-end signing inert. | Provision the dedicated secret in server env + bake into the Function; configure + hide the adjustment variant. |
| **B-8** | Currency signed but never enforced by the Function (threat #11). | Add currency check (Transform + Validation). |
| **B-9** | No shared golden vectors across the app/Function boundary → silent canonicalization drift risk. | Add `signed-quote-vectors.json` asserted by both suites. |
| **B-10** | Task 4A.5 native-button containment not implemented (prerequisite for live storefront approval). | Implement + verify (separate task). |
| **B-11** | Currency/FX, selling-plan, POS, Draft Order / Create Order API / order-edit paths are outside enforcement. | Product decision on scope + an internal staff quoting tool reusing the server engine. |

## 16. Task 5B.2 readiness — Cart & Checkout Validation extension

**NOT created in Task 5B.1.** A Validation Function extension requires a Shopify-managed UID that
can only be minted by `shopify app generate extension`, which needs Shopify authorization. No UID
was invented, copied, or placeholdered; `shopify.app.toml` was not touched.

| Item | Value |
|---|---|
| Proposed extension name | `imprintid-cart-validation` |
| Proposed handle | `imprintid-cart-validation` |
| Type | `function` |
| Target | `cart.validations.generate.run` (export `cart-validations-generate-run`) |
| Expected API version | `2026-07` (match `imprintid-cart-pricing`; re-check the latest stable at generation time) |
| **CLI command requiring approval** | `npm run shopify -- app generate extension --template cart_checkout_validation --name imprintid-cart-validation` (run from repo root — the root `package.json` `shopify` script is `shopify`, and `npm run … -- <args>` forwards the args, so this invokes `shopify app generate extension --template …`). Running it will: contact Shopify; create a Shopify-managed extension identity / UID; write local `extensions/imprintid-cart-validation/*` files; and may cause the running `shopify app dev` session to detect and rebuild the new extension. **Requires explicit authorization in Task 5B.2 — not run here.** |
| Expected local files after generation | `extensions/imprintid-cart-validation/shopify.extension.toml`, `src/cart_validations_generate_run.graphql`, `src/cart_validations_generate_run.ts`, `generated/api.ts`, `package.json`, `locales/en.default.json` |
| Reused from 5B.1 (copy into the new extension dir, same self-contained rule) | `cart-pricing-contract.ts`, `config-normalization.ts`, `hmac-sha256.ts`, `verify-payload-v2.ts` (rename its `V2LineFacts`/policy parsers as shared) |
| Input query (from `2026-07` schema) | per line: `merchandise { … on ProductVariant { id availableForSale product { id metafield(namespace:"$app:imprintid", key:"pricing_policy"){jsonValue} } } }`, `quantity`, `cost { amountPerQuantity { currencyCode } }`, the four `_imprintid_pricing_*` attributes; `shop { metafield(namespace:"$app:imprintid", key:"enforcement_policy"){jsonValue} }`; `cart { cost { totalAmount { currencyCode } } }` |
| Validation target | `$.cart` (approved default). Line-level only if O-6 resolves positively against the generated schema. |
| Tests to implement after the UID exists | (a) golden vectors from `test/fixtures/signed-quote-vectors-v2.json` → every `expect` value produces a cart-level validation error except `valid`; (b) `disabled`/`pilot`/`universal`/`maintenance` behaviour; (c) `universal` + missing product policy → error; (d) `maintenance` + any enforced product → error; (e) adjustment variant as a customer line → error; (f) error message contains no security detail (assert against a deny-list); (g) parity: the Validation verifier and the Transform verifier reach the same accept/reject decision for identical input (shared `verifyCartPricingAttributesV2`). |
| Activation (DO NOT do in 5B.2) | activating the validation in admin + deselecting "Allow all customers to submit checkout" — go-live only |

**Also recommended for Task 5B.2 (server + storefront, no Shopify writes):**

1. Real `CartPricingPolicyProvider` implementation backed by the app-owned metafields once their
   **definitions** exist (still no *values* written) — replaces `nullCartPricingPolicyProvider`.
2. App-owned metafield **definitions** via a guarded admin action; a **dry-run** bulk-sync command
   with coverage/exception reporting.
3. Storefront: wire `dynamic-pricing.js` to submit the four v2 attributes when the server returns a
   v2 `cartPricing` (behind the same "v2 only when revisions available" gate); clear stale v2
   attributes on any selection change; keep every Task 2B/4A quote-ownership guard.
4. Docs: promote `cart-pricing-contract.ts` to the single normative spec; runbook for the
   block-on-exception setting; O-6 schema check for line-level targeting.
5. Verification: all suites green; typecheck/lint/build; `git diff --check`.
6. **Out of scope for 5B.2:** `shopify app deploy`, activating either Function, the block-on-exception
   toggle, writing any metafield *value*, the 6,500-product migration, resolving B-1/B-2.

Task **5C** = distribution migration (B-1) + O-2 resolution + production secret provisioning +
staged rollout stages 1–3. Task **5D** = universal mode (stages 4–6).

---

## 17. Task 5B.3 readiness — provision, wire, activate on the development store

**Not performed in 5B.2.** The Validation extension is generated (UID
`f6c40ee2-…`, handle `imprintid-cart-validation`, target `cart.validations.generate.run`,
API `2026-07`) and locally implemented as a **development draft** — not deployed, not
activated, no Checkout Rule.

| # | 5B.3 step | Detail |
|---|---|---|
| 1 | **App-owned metafield definitions** | Create (via a guarded admin action) `$app:imprintid/enforcement_policy` (shop, `json`, app-owned, `MERCHANT_READ`) and `$app:imprintid/pricing_policy` (product, `json`, app-owned, `MERCHANT_READ`). No *values* yet. |
| 2 | **Shop policy provisioning** | Write one `enforcement_policy` value for the dev store: `{ schema:1, mode:"pilot", enabled:true, allowLegacyV1:false, adjustmentVariantGid, installBinding:<random>, policyRevision:1 }`. |
| 3 | **LNY01 product policy** | Write `pricing_policy` on product `9442404663548`: `{ schema:1, required:true, profileRef:"prof_LNY01", profileRevision:1, active:true, policyRevision:1 }`. |
| 4 | **Real `CartPricingPolicyProvider`** | Implement the interface (replaces `nullCartPricingPolicyProvider`) backed by the metafields + the pricing DB; bump `profileRevision` on any LNY01 pricing change. |
| 5 | **Function signing-secret compilation** | `IMPRINTID_CART_SIGNING_SECRET=<value> node scripts/generate-config.mjs` in **both** `imprintid-cart-pricing` and `imprintid-cart-validation`; same value in the server env. |
| 6 | **Adjustment-variant provisioning** | One dedicated variant; set `IMPRINTID_ADJUSTMENT_VARIANT_ID`; remove from collections / nav / search (do **not** rely on "unavailable"). |
| 7 | **v2 enablement** | Server env `IMPRINTID_CART_ENVELOPE_VERSION=2` (dev). Storefront `dynamic-pricing.js` v2-attribute submission (Task 5B.2 item 3, still pending). |
| 8 | **Dev-store Validation activation** | `shopify app deploy` (a dev/draft version), then in Admin create + activate a Checkout Rule for `imprintid-cart-validation` and **deselect "Allow all customers to submit checkout"**. |
| 9 | **Live Ajax / Storefront / accelerated-checkout tests** | Exercise every §5 threat on the real dev store across the theme AJAX cart, Storefront API `cartLinesAdd/Update`, and Shop-Pay accelerated checkout; confirm each is blocked. |
| 10 | **Function execution replay** | Capture the real post-Transform Validation `Input` via `shopify app function replay`; confirm the effective-price / component-multiset semantics and flip `EFFECTIVE_PRICE_ENFORCED` on with confidence. |
| 11 | **Safe rollback** | Rehearse `mode="maintenance"` (block, no native fallback) and `enabled:false` (business-authorized native fallback); confirm in-flight valid carts behave as documented. |

## 18. Effective-price / component-multiset — LIVE VERIFICATION REQUIRED

`imprintid-cart-validation` implements two price-integrity checks:
1. **component multiset** — when a validated parent line has expanded children, the
   observed `{merchandise, quantity, per-unit cents}` multiset must equal
   `expectedExpandedComponents(payload)` (cross-checked against the Transform's real
   `runCartTransform` output for every golden vector);
2. **pre-discount subtotal** — for a childless line, `cost.subtotalAmount` (Shopify: the
   amount **before discounts** — so a discount never causes a false mismatch) must equal
   the signed `lineTotalCents`.

Both are behind `EFFECTIVE_PRICE_ENFORCED = false` because **the exact post-Cart-Transform
Validation `Input` shape (whether the parent appears as a top-level line, whether children
are individually present, how `parentRelationship` is populated at `CART_INTERACTION` vs.
`CHECKOUT_INTERACTION`) cannot be proven from local fixtures.** A `shopify app function
replay` against a real transformed cart on the dev store is a **mandatory pre-activation
gate**; only then is the flag flipped on.

## 19. CHANGE LOG — Task 5B.2

- Generated `imprintid-cart-validation` (UID `f6c40ee2-077e-ec69-1857-fc896b1265893588c64d`,
  Shopify-minted) via `shopify app generate extension --template cart_checkout_validation`
  + `--flavor typescript`. `shopify.app.toml` **not** modified by generation.
- Implemented `cart.validations.generate.run` (dev-draft): mirrored security contract
  (`cart-pricing-contract`, `config-normalization`, `hmac-sha256`, `verify-payload-v2`);
  `decimal-cents.ts` (no-float money parser); `normalize-input.ts` (generated types →
  validated internal shape, no `any` of the full input); `expanded-components.ts`
  (component-multiset, cross-checked vs. the Transform).
- Modes: A missing/malformed shop policy → one global `$.cart` "temporarily unavailable"
  error (never legacy compat). B `disabled` → native OK (direct-adjustment still blocked).
  C `pilot` / D `universal` per §7. E `maintenance` → one global unavailable error, no
  native fallback. F kill switch → treated as `disabled`.
- **v1 is always rejected for an enforced line.** Selling-plan on an enforced line → block
  (distinct message). Direct adjustment variant → block. Nested components validated
  against the parent's signed quote + multiset.
- Errors: generic customer-safe messages only (no codes/ids/secrets — asserted), `$.cart`
  target only, deterministic order, deduplicated, `MAX_ERRORS = 5`.
- Input query trimmed to **complexity 30** (Shopify Validation limit; parent subtree is
  shallow — no parent product metafield). Function **builds successfully** (WASM); the
  running dev server registered it as a **draft** ("Extension changed ✅ Updated dev
  preview") — no deploy/activation.
- The generated vitest boilerplate (`tests/`, `vitest.config.js`) was removed; tests are
  `node --test` `.ts` files matching the repo convention.

---

## V1 COMPATIBILITY — explicit transition (Task 5B.1 / **5B.1.1**)

| Point | Statement |
|---|---|
| **No implicit legacy mode (5B.1.1)** | The **absence** of a shop `enforcement_policy` metafield — and any malformed / incomplete / unsupported-schema policy — is **fail-closed / NO Transform operation**. It is NEVER interpreted as "backward compatibility". |
| Transform authorization for v1 (5B.1.1) | A legacy v1 quote is processed **only** when the shop policy is valid, `mode = "pilot"`, `allowLegacyV1 === true` (explicit; missing field ⇒ `false`), **and** the line's product carries an active `required` `pricing_policy`. `universal`, `maintenance`, `disabled`, and the kill switch all reject v1. |
| Server issuance of v1 (5B.1.1) | The storefront issues a **new** v1 quote only when ALL of: runtime is not production (`NODE_ENV !== "production"`); `IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1 === "true"`; `IMPRINTID_CART_ENVELOPE_VERSION === "1"`. **Production never issues a v1 quote.** An absent or unsupported `IMPRINTID_CART_ENVELOPE_VERSION` yields `cartPricing: null` — **no silent downgrade to v1**. |
| Security guarantee | **None new.** v1 binds variant + quantity + priced fields via HMAC, but NOT product GID, profile/policy revision, or configuration digest, and has **no replay/expiry protection** — the Function-side `expiresAt` / `Date.now()` check was removed (Functions may not use a clock). |
| Clock | v1 in the Function uses **no clock**. `expiresAt` is parsed for shape compatibility and ignored. |
| Failure behaviour | A rejected / missing / absent-policy v1 quote produces **no Transform operation** → the line shows its **native price**. Native-price exposure therefore remains until the Validation Function (5B.2) is generated, implemented, and activated — so cart signing and enforced rollout stay disabled until then. |
| Universal enforcement gate | **`mode = universal` MUST NOT be enabled while v1 issuance is possible.** v1 is a bypass (a v1 quote for a minimal config could be applied to a premium job). Universal mode requires: v2 is the only issued envelope, the Validation Function is active, and the metafield policy is fully synced. |
| Removal gate / migration | v1 support is removed when: (a) the storefront emits v2 for 100% of enforced products; (b) the Validation Function is active in `universal` mode; (c) a monitoring window shows zero v1 quotes for ≥ 2 weeks. Target: **Task 5D**. `verifyCartPricingAttributes` (v1) stays only as "LEGACY / COMPATIBILITY ONLY" for controlled transition fixtures. |
| `quoteId` / `issuedAtServer` | `quoteId` is **audit identity only** — a Function has no database to check it against, so there is **no Function-side replay ledger**. `issuedAtServer` is **advisory only** (signed for tamper-evidence; never clock-compared in a Function). |

---

## CHANGE LOG

- **Task 5B.1** — corrected §1 D3 / §3 (`lineExpand` Basic-plan = **CONDITIONAL**, not blocked);
  §6C (removed "mark adjustment variant unavailable" as a requirement; secure design = role
  metafield + storefront hiding + Validation reject + identity checks); §9 (approved validation
  target = `$.cart`; line-level only if O-6 proves it; softened the "Allow all customers" claim to
  "blocks checkout on exception; other surfaces to be verified"); §6A / §11 / §12 (four explicit
  modes incl. `maintenance` as the secure pricing-incident rollback; `enabled=false → native price`
  removed as the default rollback). Added `installBinding` to the shop policy (the Function has no
  `Shop.id`). Implemented: `cart-pricing-contract.ts`, `config-normalization.ts`, v2 signing,
  Cart Transform hardening (no clock, v2 verify, modes), `test/fixtures/signed-quote-vectors-v2.json`.

- **Task 5B.1.1** — closed pre-Validation fail-open gaps:
  - **Removed the implicit v1 fail-open.** A missing / malformed shop policy now yields
    **NO Transform operation** (never "legacy mode"). Added `allowLegacyV1: boolean` (default
    `false`) to the shop policy; v1 is Transform-processed only under `pilot` + `allowLegacyV1:true`
    + an active `required` product policy. `universal` / `maintenance` always reject v1.
  - **Removed the silent server default to v1.** `IMPRINTID_CART_ENVELOPE_VERSION` has no default:
    absent / unsupported ⇒ `cartPricing: null`. v2 never downgrades to v1. A new v1 quote is issued
    only for a controlled non-production transition (`NODE_ENV !== "production"` +
    `IMPRINTID_ALLOW_LEGACY_CART_PRICING_V1 === "true"` + version `"1"`). `.env.example` updated
    (names + safe comments only).
  - **Generated Function types.** Ran `shopify app function typegen` for `imprintid-cart-pricing`
    (no extension creation / UID / deploy / remote mutation). Deleted `src/function-input.ts`; the
    Function consumes the generated `CartTransformRunInput` and validates it into a small internal
    `NormalizedTransformInput` (no `any`, no invented whole-input interface).
  - **Strict policy parsing** — plain object, exact `schema` version, supported `mode`, boolean
    `enabled` / `allowLegacyV1` / `required` / `active`, bounded non-blank `installBinding` /
    `profileRef`, `gid://shopify/ProductVariant/<id>` `adjustmentVariantGid`, positive-safe-integer
    revisions, **no unknown keys**, bounded serialized size. Every field has a fail-closed test.
  - **Transport byte-size audit** (`cart-pricing-transport-size.test.ts`) — measured UTF-8 bytes
    (see §6 of the 5B.1.1 report). The 4096 / 8192 limits are **this system's own** bounds, not
    Shopify guarantees; live per-surface property-size verification is a **Task 5B.2 / 5C release
    gate**.
  - Corrected §16 command to `--template cart_checkout_validation`; `quoteId` = audit-only /
    no Function-side replay ledger; `issuedAtServer` = advisory only; reiterated native-price
    exposure until Validation is active.

- **Task 5B.3A** — authoritative v2 quote issuance wired end to end. `nullCartPricingPolicyProvider`
  replaced by `createDefaultCartPricingPolicyProvider({ prisma, admin })` reading the app-owned
  `enforcement_policy` / `pricing_policy` metafields (no store/product hard-coding). Payload bound
  strictly from server-trusted sources (identity GIDs from the Admin-verified `requestIdentity`,
  cents from the engine result, revisions/installBinding/adjustment from the provider, digest from
  server-side `normalizeConfig`). Signing: `IMPRINTID_CART_SIGNING_SECRET` only — no
  `SHOPIFY_API_SECRET` fallback, no v1 fallback, secret never in the response/logs. Expiry is
  DERIVED from the signed `issuedAtServer + V2_QUOTE_TTL_SECONDS` (browser-enforced only — no
  `expiresAt` field, no Function clock). Browser: v2 attributes treated as opaque, stored only with
  their quote, cleared synchronously on product/variant/quantity/config change and on abort/fail,
  older-generation responses rejected, complete-owning-unexpired v2 required before Add to Cart,
  submitted unchanged, never v1.

- **Task 5B.3A.1** — the AUTHORITATIVE THREE-STATE policy decision. `CartPricingPolicyProvider.resolve()`
  now returns a discriminated union instead of `context | null`:
  - `{ action: "enforce", context }` — issue a signed v2 quote; keep native cart contained.
  - `{ action: "bypass", reason: "shop_disabled" | "pilot_unmarked" }` — enforcement is explicitly,
    safely OFF (a `disabled`/`enabled:false` shop policy, or a valid `pilot` policy with the product
    genuinely absent or `required:false`): NO signed quote, and the storefront RELEASES native
    containment.
  - `{ action: "block", reason: … }` — a mandatory fail-closed condition (`maintenance`, missing/
    malformed shop policy, malformed/inactive required product policy, `universal` product with no
    policy, provider/GraphQL failure, missing signing/adjustment config): NO signed quote, native
    cart STAYS contained.
  The storefront response carries `data.enforcement.state` (`enforce`/`bypass`/`block` — the
  *reason* stays server-side) on BOTH the catalog GET and the pricing POST. The browser defaults to
  `block` (contained) and only ever releases on an explicit, server-observed `bypass`; a block that
  fails closed on metadata before any request stays contained regardless of policy (documented
  double-fault). `null` → `block` provider (`nullCartPricingPolicyProvider`, `configuration_unavailable`).

- **Task 5B.3B.2** — CURRENCY SAFETY + provisioner hardening.
  - **Single currency, NO foreign-exchange.** `app/lib/pricing-api/currency-contract.ts` +
    `normalizeCurrencyCode` (mirrored in `cart-pricing-contract.ts` ×3). The server issues a signed
    v2 quote ONLY when the pricing-profile currency equals the authenticated shop currency
    (`resolveEnforceableCurrency`; the `enforce` decision now carries `context.shopCurrency` from
    Admin `shop.currencyCode`). No default — a missing profile currency is `CURRENCY_CONTEXT_UNAVAILABLE`,
    not "assume USD". The browser cannot supply or override a currency. Reasons:
    `PROFILE_SHOP_CURRENCY_MISMATCH` (server, pre-sign), `QUOTE_CART_CURRENCY_MISMATCH` (Function
    reject code `currency_mismatch`), `CURRENCY_CONTEXT_UNAVAILABLE` (server: no quote; Function
    reject code `currency_context_unavailable`).
  - **Function currency check is MANDATORY.** `verifyCartPricingAttributesV2` now fails closed when
    the cart line has no verifiable currency (was: silently skipped) and when it differs from the
    signed currency. The Cart Transform additionally refuses to expand a v2 line under a non-par
    `presentmentCurrencyRate` and always formats v2 components at par — NO FX math on a signed quote.
    The Validation Function blocks the required product on either currency failure.
  - **Phased provisioner** — `scripts/shopify/` (tracked, reviewable) replaces the one-step
    `.shopify/provision-5b3b.mjs --apply`. Explicit phases `--check` / `--prepare` / `--activate` /
    `--enable-pilot` / `--rollback-check`; no phase silently performs a later one. `--activate`
    refuses to run without prepared-state evidence AND matching signing-secret fingerprints across
    the app server + both Functions; `--enable-pilot` refuses until both resources read back
    correctly and currency is enforceable. Full idempotent reconciliation of the adjustment
    product/variant; STOP on foreign/ambiguous resources. Git-ignored non-secret recovery receipt
    (`.shopify/provision-receipt.json` — fingerprint only, never the token/secret).
    `--check` never exits early and reports current state / planned mutations / currency readiness /
    conflicts / idempotency / GO-NO-GO per phase. `generate-config.mjs` reads the git-ignored `.env`
    when `IMPRINTID_CART_SIGNING_SECRET` is unset, so the manual `npm run fn:config` boundary needs
    no secret on the command line.

---

### POC (this task)

`app/lib/pricing-api/enforcement-envelope.poc.test.ts` — pure, non-production, imported by nothing:
canonical-string stability under key reordering; config-digest change detection; revision-mismatch
as a clockless pure function. Illustrative vectors for Task 5B.
