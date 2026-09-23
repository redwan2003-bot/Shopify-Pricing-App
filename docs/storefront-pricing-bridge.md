# Storefront pricing bridge (Phase 2.5)

How an anonymous Shopify storefront visitor's browser can request dynamic pricing
without ever touching admin credentials, and without this app duplicating any pricing
logic. This assumes [`docs/pricing-engine.md`](./pricing-engine.md) (Phase 2.3) and
[`docs/pricing-api.md`](./pricing-api.md) (Phase 2.4, `/api/pricing`, still unchanged
and still admin-only).

## 1. Overall architecture

```
Customer's browser (storefront product page)
        │  POST /apps/imprintid-pricing/pricing
        ▼
Shopify's edge — verifies the request is for an installed shop, appends
shop / timestamp / signature (HMAC'd with this app's secret), forwards it
        │
        ▼
app/routes/apps.imprintid-pricing.pricing.tsx   ← NEW this phase
        │  authenticate.public.appProxy(request)   — verifies Shopify's signature,
        │                                             resolves shop from session storage
        ▼
app/lib/pricing-api/storefront-handler.ts       ← NEW this phase
        │  handleStorefrontPricingRequest() — delegates to the exact same
        │  handlePricingApiRequest() that /api/pricing (Phase 2.4) already uses
        ▼
app/lib/pricing/index.ts — calculatePrice()      ← Phase 2.3, UNCHANGED
        │
        ▼
Prisma → pricing database (Phase 2.1/2.2, UNCHANGED)
        │
        ▼
JSON pricing response → back through the App Proxy → the storefront page
```

`/api/pricing` (Phase 2.4) is completely untouched — it remains the
`authenticate.admin`-gated route for authenticated admin-side use. This phase adds a
second, parallel entry point for anonymous storefront traffic; neither route
duplicates pricing calculation — both call `calculatePrice` through
`handlePricingApiRequest`.

## 2. App Proxy configuration

Added to `shopify.app.toml`:

```toml
[app_proxy]
url = "https://example.com/apps/imprintid-pricing"
prefix = "apps"
subpath = "imprintid-pricing"
```

`https://example.com` is the same dev placeholder already used for `application_url`
and `[auth].redirect_urls` in this file, rewritten together by `shopify app
dev`/`deploy` (`automatically_update_urls_on_dev = true`) — not something fabricated
for this phase.

## 3. Proxy URL

Storefront calls: `https://{shop}.myshopify.com/apps/imprintid-pricing/pricing`
Shopify forwards to: `{application_url}/apps/imprintid-pricing/pricing`

## 4. Storefront route

`app/routes/apps.imprintid-pricing.pricing.tsx`, resolved by this project's existing
flat-route convention to `/apps/imprintid-pricing/pricing`. `POST` only — any other
method returns `405`.

## 5. Tenant resolution (critical — read this before changing anything here)

The storefront visitor's browser never supplies a shop domain, store ID, or any
tenant identifier — the request body schema doesn't even have a field for one (see
§6). The trusted shop comes entirely from Shopify's own infrastructure:

1. Every request forwarded through the App Proxy has `shop`, `timestamp`, and
   `signature` appended to its query string **by Shopify's edge**, not by the
   storefront JavaScript. `signature` is an HMAC-SHA256 over the sorted query
   parameters, keyed with this app's API secret — something only Shopify's servers
   and this app know.
2. `authenticate.public.appProxy(request)` (the same SDK every other route in this
   app uses) recomputes that HMAC locally and rejects the request outright (`400`,
   thrown before any of this route's own code runs) if it doesn't match. This was
   verified directly — see §11 Case C: a request with a forged signature is rejected.
3. Only once the signature is verified does the SDK look up an **offline session**
   for the shop named in that verified query string, and return it as `session`. This
   route reads `session.shop` — never `request.url`'s `shop` param directly, never
   anything from the JSON body.
4. If no offline session exists for that shop (app not installed / uninstalled), the
   route returns `404 SHOP_NOT_AVAILABLE` rather than proceeding — verified directly,
   §11 Case D.

A storefront visitor cannot make this route price a different store's catalog: there
is no code path from the request (query string or body) to `shopDomain` other than
this verified chain. This mirrors exactly how Phase 2.4 guarantees the same thing for
the admin route, just with `authenticate.public.appProxy` in place of
`authenticate.admin`.

## 6. Request format

Identical to `/api/pricing`'s (Phase 2.4) — the same `CalculationInput` shape, minus
`shopDomain`:

```json
{
  "sku": "LNY01",
  "quantity": 1000,
  "decoration": {
    "method": "SCREEN_PRINT",
    "colors": 2,
    "locations": 2,
    "reverseSide": true,
    "differentReverseArtwork": true,
    "repeatOrder": true
  },
  "options": [{ "groupName": "Optional Features", "optionValueId": "<real OptionValue.id>" }],
  "production": { "code": "RUSH" }
}
```

Reuses `parsePricingRequestBody` (Phase 2.4) unchanged — no second request model was
invented. **Method:** `POST`, not `GET` — Shopify's App Proxy signs and forwards both,
but a rich, nested configuration object (decoration + options array + production +
packaging) doesn't fit cleanly or safely into a query string, and the signature
verification only covers query parameters anyway, so there's no security reason to
prefer GET. POST is also consistent with `/api/pricing`.

## 7. Response format

```json
{ "ok": true, "data": { /* PricingCalculationResult, minus "source" */ } }
```
```json
{ "ok": false, "error": { "code": "QUANTITY_BELOW_MINIMUM", "message": "..." } }
```

**One deliberate difference from `/api/pricing`:** the storefront response omits
`source` (`storeId`, `pricingProfileId`, `resolvedVia`) — internal Prisma
bookkeeping a storefront customer has no use for. Everything a pricing UI actually
needs — `quantityTier`, `base`, `decoration`, `options`, `production`, `packaging`,
`totals` — is preserved verbatim. See `app/lib/pricing-api/storefront-handler.ts`.

## 8. Error handling

Identical mapping to Phase 2.4 (`mapPricingErrorToStatus`, `toErrorBody`, reused
unchanged): not-found errors → `404`; any other domain error → `422`; boundary/shape
errors → `400`; unexpected → `500` with the same fixed, non-leaking message. Plus one
new storefront-specific case: `404 SHOP_NOT_AVAILABLE` when the App Proxy signature is
valid but no installed-app session exists for that shop.

## 9. Security model

- **`/api/pricing` is unmodified and still `authenticate.admin`-gated.** This phase
  did not touch that route, its authentication, or its response shape.
- **No CORS was added anywhere.** The App Proxy path doesn't need it — the browser
  calls `https://{shop}.myshopify.com/apps/...` (same-origin to the storefront page),
  and Shopify's edge does the cross-origin forwarding to this app server-to-server.
- **No admin credentials are reachable from this route.** `authenticate.public.appProxy`
  returns `admin`/`storefront` API clients only when a session exists, and this route
  never touches them — it only reads `session.shop` and calls `calculatePrice`.
- **The customer cannot select a store, a price, or override a database value** — see
  §5, and the request schema (§6) has no field for any of that.
- Full checklist re-verified this phase: see §13 in the final report.

## 10. Theme / App Extension integration

Not built in this phase (explicitly deferred by the stop conditions — no theme
modification, no pricing UI). For the record, on inspection: this project's
`extensions/` directory currently holds only a placeholder (`.gitkeep`) — no theme app
extension exists yet. When the storefront UI phase builds one, a **Theme App
Extension** (app embed or app block, injected via Shopify's supported extension
points) is the correct mechanism — never editing the merchant's live theme files
directly. That extension's JavaScript would call this phase's endpoint exactly as
described in §6/§7. Scaffolding that extension is left to the phase that actually
builds the pricing UI, per this phase's stop condition ("prepare the API contract so
the next phase can build the actual storefront pricing UI" — not build the UI itself).

## 11. LNY01 verification

Two layers, matching what could and couldn't run under this project's `node --test`
setup (same module-resolution constraint noted in Phase 2.4's report — `app/shopify.server.ts`
uses extensionless imports only Vite resolves):

**Automated (`npm test`, part of the permanent suite):**
`app/lib/pricing-api/storefront-handler.test.ts` — 12 tests, covering every case in
this phase's test list except the App Proxy signature/session layer itself, against
the real database (including the real seeded LNY01 profile for the success cases).

**Manual, genuinely end-to-end (`npm run verify:app-proxy`):** constructs a real
Shopify-App-Proxy-style HMAC signature (same algorithm the SDK itself uses —
`stringifyQueryForAppProxy` + `HMAC-SHA256` with the app secret), seeds the real LNY01
pricing package (`buildLny01PricingInput`, the actual Phase 2.2 seed data source) into
a disposable store, inserts a real offline `Session` row, and calls the actual
exported `action` from `app/routes/apps.imprintid-pricing.pricing.tsx` directly (via
`scripts/resolve-ts-loader.mjs`, a custom Node loader needed only because this
project's non-`lib` files use extensionless imports). All disposable data is deleted
in a `finally` block. Last run (captured in this report, not fabricated):

| Case | What it proves | Result |
|---|---|---|
| A | Minimal valid signed request → real LNY01 pricing at qty 1000 (164¢ list / 98¢ net unit) | `200`, ✅ |
| B | Full worked example (2 colors, 2 locations, reverse art, repeat order, an option, rush) | `200`, totals **258500¢ list / 178600¢ net** — matches the exact figures independently verified in Phase 2.3 and Phase 2.4 | ✅ |
| C | Forged/invalid signature | rejected, not `200` | ✅ |
| D | Valid signature, shop has no installed-app session | `404 SHOP_NOT_AVAILABLE` | ✅ |

**10/10 checks passed.** Nothing above was hardcoded into application code — the
expected LNY01 figures in the script are assertions against numbers already
independently verified in earlier phases, checked against what the live call actually
returned.

## 12. How Phase 2.6 will consume this endpoint

A Theme App Extension's JavaScript, running on the LNY01 product page, will `fetch`
`POST /apps/imprintid-pricing/pricing` (same-origin, no CORS needed) whenever the
customer changes quantity/decoration/options, with a debounce, and render
`data.totals` / `data.decoration.charges` / etc. from the response — replacing the
static pricing table with the actual return value of this endpoint. That phase should
not need to change anything in this one; the contract (§6/§7) is the seam.
