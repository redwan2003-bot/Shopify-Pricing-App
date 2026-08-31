# Storefront dynamic pricing UI (Phase 2.6)

The Theme App Extension that renders a live pricing block on the product page, backed
entirely by the Phase 2.5 App Proxy bridge and the Phase 2.3 calculation engine. This
assumes [`docs/storefront-pricing-bridge.md`](./storefront-pricing-bridge.md) (Phase
2.5) and [`docs/pricing-engine.md`](./pricing-engine.md) (Phase 2.3).

No backend calculation logic changed this phase. Two additive, read-only changes were
made to support the UI — both explained in §1 below — and nothing else in
`app/lib/pricing/{calculator,repository}.ts`'s actual pricing math was touched.

## 1. What changed on the backend, and why

**`PricingCalculationResult.availableQuantityTiers`** (new field, `app/lib/pricing/types.ts` /
`calculator.ts`): the existing `quantityTier` field only ever reported the *one* tier
selected for the requested quantity — there was no way to render a quantity-break table
("order 1000+ for $0.98/unit") without it. Per this phase's own instruction ("if the API
response does not expose enough information... expose only the minimum additional
read-only data required, preserve backward compatibility, add tests"), one new array
field was added: every configured `QuantityTier`, sorted ascending, in the exact same
shape `quantityTier` already used. It's purely additive — nothing existing changed
shape — and is covered by new tests in `calculator.test.ts`, `lny01.test.ts`, and
`storefront-handler.test.ts`.

**`app/lib/pricing-api/catalog.ts` + a new `GET` handler on the existing App Proxy
route** (`app/routes/apps.imprintid-pricing.pricing.tsx`): the calculation endpoint only
ever echoes back what was *selected*, never the catalog of what's *selectable* — so
there was no way to render real option/production choices without either hardcoding
them (explicitly forbidden) or adding a read-only lookup. `loadPricingCatalog` does no
pricing arithmetic; it calls the exact same `loadPricingContext` that `calculatePrice`
itself calls (same tenant scoping, same SKU/override resolution, same `isActive` check)
and re-shapes the already-loaded profile data into a browsable form. See that file's
top comment for the full reasoning. Covered by `catalog.test.ts` against the real
seeded LNY01 profile.

Both changes were verified not to affect `/api/pricing` or any existing test — the full
previously-passing suite still passes unmodified (see §15).

## 2. Extension name and block

- Extension: `imprintid-dynamic-pricing` (generated via `shopify app generate extension
  --template theme_app_extension`, at `extensions/imprintid-dynamic-pricing/`)
- Block: **Dynamic Pricing** (`blocks/dynamic-pricing.liquid`), `target: "section"` —
  addable to the product template (or any section) in the Theme Editor
- Assets: `dynamic-pricing.js` (ES module, the block's behavior),
  `dynamic-pricing-utils.js` (ES module, pure formatting helpers — imported by the
  above, and independently unit-tested), `dynamic-pricing.css` (scoped styles)
- Locale strings: `locales/en.default.json`

## 3. Storefront endpoints used

Both on the existing Phase 2.5 route, `app/routes/apps.imprintid-pricing.pricing.tsx`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/apps/imprintid-pricing/pricing?sku=LNY01` | catalog: quantity tiers, option groups/values, production rules — **new this phase** |
| `POST` | `/apps/imprintid-pricing/pricing` | calculate a price — unchanged from Phase 2.5 |

## 4. Request payload (POST)

Exactly the Phase 2.4/2.5 `CalculationInput` contract, unchanged:

```json
{
  "sku": "LNY01",
  "quantity": 1000,
  "decoration": { "method": "SCREEN_PRINT", "colors": 2, "locations": 2, "reverseSide": true, "differentReverseArtwork": true, "repeatOrder": true },
  "options": [{ "groupName": "Optional Features", "optionValueId": "<real id from the GET catalog response>" }],
  "production": { "code": "RUSH" }
}
```

## 5. Response consumed

```json
{ "ok": true, "data": { /* PricingCalculationResult minus "source", now including availableQuantityTiers */ } }
```
```json
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

## 6. UI components implemented

One block, `blocks/dynamic-pricing.liquid` + `assets/dynamic-pricing.js`:

- Quantity input (labeled, `type="number"`, `min` set from the lowest real tier)
- Decoration controls (only shown if the catalog reports a decoration method): colors
  (1 / 2+), locations (1 / 2), reverse side, different reverse artwork (shown only
  when reverse side is checked), repeat order
- One `<select>` per real `OptionGroup` from the catalog (required groups have no
  blank option; optional groups do) — group names and value labels come from the API,
  never hardcoded
- Production `<select>`, one `<option>` per real `ProductionRule`, showing its lead
  time; a hint line shows `relatedSku` or `notes` when present, never a fee that
  wasn't configured
- Result: List Price/unit, Your Price (net)/unit, Total (net)
- Quantity-break table (from `availableQuantityTiers`), current tier marked
- Expandable pricing breakdown (`<details>`) built from the response's own line items
  only — Base Product, Decoration, Options, Production, List Total, Total

## 7. Dynamic fields supported

Every field STEP 5–9 of the phase asked for: quantity, decoration (method, colors,
locations, reverse side, different reverse artwork, repeat order), options (dynamic,
per real catalog), production (dynamic, per real catalog). Packaging is not a UI
control — consistent with `docs/pricing-engine.md` §8 ("packaging is not user-selected,
it's reported"); the response's `packaging` field is available for a future phase to
surface if desired.

## 8. How SKU / product context is resolved

```liquid
{%- assign pricing_product = block.settings.product | default: product -%}
{%- assign resolved_sku = block.settings.sku_override | default: pricing_product.selected_or_first_available_variant.sku -%}
```

SKUs belong to variants in Shopify, not products, so the block reads the current
product's first available variant's SKU. A merchant-configurable "Override SKU" block
setting exists for previewing the block before a product's real SKU is set. If neither
resolves to a non-empty value, the block renders its unavailable state and **never
calls the pricing API** (no request is made with an empty SKU) — satisfying "fail
gracefully rather than display a fake/default price." The tenant (shop) is resolved
entirely server-side by the existing App Proxy authentication (Phase 2.5) — the
browser never supplies a shop/store identifier.

## 9. Loading / error handling

- Initial catalog load: a `[data-imprintid-pricing-loading]` message, then either the
  full panel or the unavailable message.
- Every subsequent recalculation: the panel dims (`data-loading="true"`) rather than
  disappearing, so the last valid price stays visible while a new one loads.
- Quantity/selection changes are debounced (300ms) before firing a request.
- Every request carries an `AbortController`; a new request aborts the previous one,
  and responses are additionally sequence-numbered so a slow, superseded response can
  never overwrite a newer one on screen.
- Four error messages, mapped from the response's `error.code` (STEP 15):
  1. Unsupported product/SKU (`STORE_NOT_FOUND`, `PRICING_PROFILE_NOT_FOUND`,
     `PRICING_PROFILE_INACTIVE`, `SHOP_NOT_AVAILABLE`)
  2. Invalid quantity (`INVALID_QUANTITY`, `QUANTITY_BELOW_MINIMUM`)
  3. Configuration error (every other domain error — bad option/production selection, etc.)
  4. Network/server failure (fetch rejection, non-`ok` body)
- None of these ever render `error.message` verbatim from the server, and never a raw
  Prisma error, stack trace, or internal ID — only the four fixed, translatable
  messages above.

## 10. Accessibility

- Every input has a real `<label for>`; the quantity field's error text is linked via
  `aria-describedby` and toggles `aria-invalid`.
- Errors render with `role="alert"`; the result panel and loading message use
  `aria-live="polite"` so screen readers announce price updates.
- All controls are native `<input>`/`<select>`/`<details>` elements — fully
  keyboard-operable with no custom widget logic.
- `:focus-visible` outlines are explicitly preserved in the CSS (never suppressed).
- The quantity-break table uses `<caption>`/`<th scope="col">`/`<th scope="row">` and
  marks the active tier with `aria-current="true"`.

## 11. Responsive behavior

Scoped entirely under the `.imprintid-pricing` class (no bare-element or global
selectors — see `dynamic-pricing.css`'s top comment), relative units throughout, a
single `min-width: 40em` breakpoint that only adjusts input widths, and colors sourced
from `currentColor`/neutral tokens so the block sits inside whatever theme it's placed
in rather than importing an unrelated design system.

## 12. Installing the block (Theme Editor)

1. `Online Store → Themes → Customize`, on the product page template.
2. `Add block` (or `Add section`, since this block's `target` is `"section"`) →
   under **Apps** → **Dynamic Pricing**.
3. Optionally set an **Override SKU** for previewing before a real product SKU exists.
4. Save.

## 13. Removing/hiding the existing static LNY01 pricing table

The static pricing table lives in the LNY01 product's **description** field in
Shopify Admin (`Products → LNY01 → Description`), not in this repository — this app
has never had a real Shopify product ID for LNY01 (documented since Phase 2.2), so
there is nothing in this codebase that generates or controls that HTML, and this phase
did not touch it, per the stop conditions ("Do NOT automatically delete the existing
product description"). To retire it once the Dynamic Pricing block is placed and
verified: edit the product description in Shopify Admin and remove the static pricing
table markup (or leave the rest of the description and delete only the table), then
place the Dynamic Pricing block above/below the description block in the Theme
Editor's product page layout, in whichever position matches the old table's visual
spot.

## 14. Testing LNY01

**Automated** (`npm test`, part of the permanent suite) — see §15/16 for what's covered
by `catalog.test.ts`, `calculator.test.ts`, `lny01.test.ts`, `storefront-handler.test.ts`,
and `dynamic-pricing-utils.test.ts`.

**Genuine end-to-end** (`npm run verify:app-proxy`) — extended this phase to chain
exactly what the browser does: a genuinely HMAC-signed `GET` for the LNY01 catalog,
extracting a real `OptionValue.id` from that response, then a genuinely signed `POST`
using that id — 17/17 checks passed; see §16 for the full run.

**Not performed:** an actual `shopify app dev` session with a live browser placing the
block in a real Theme Editor and clicking through quantities/options. This sandboxed
environment has no network access to Shopify and no browser — see Limitations (§18).

## 15. Known limitations

- **No live browser/Theme Editor session was run** (§14). Every other layer — the
  extension's structure (validated by Shopify CLI's own `theme check` via `shopify app
  build`), the full request/response contract, and real seeded-data calculation — was
  verified genuinely, not simulated.
- **Packaging has no UI control** (by design — see §7).
- The "2 colors" / "2 locations" UI options represent the engine's own binary-gate
  semantics documented in `docs/pricing-engine.md` §5 (2 or more colors are priced
  identically) — the UI doesn't offer 3+ because the backend has no rule to price it.
- i18n: only English (`en.default.json`) strings were written; the locale-key
  structure supports adding more languages without any JS/Liquid changes.
