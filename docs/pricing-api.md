# Pricing API (Phase 2.4)

`POST /api/pricing` is a thin HTTP adapter around the Phase 2.3 calculation engine
(`calculatePrice`, in [`app/lib/pricing`](../app/lib/pricing/)). It contains no pricing
calculation of its own — everything price-related is delegated to that engine; this
layer only authenticates, parses, validates the request *shape*, and maps the result to
JSON. See [`docs/pricing-engine.md`](./pricing-engine.md) for how prices are actually
computed.

## 1. Endpoint

```
/api/pricing
```

Implemented in [`app/routes/api.pricing.tsx`](../app/routes/api.pricing.tsx), following
this project's existing flat-route file convention (same pattern as
`webhooks.app.scopes_update.tsx` → `/webhooks/app/scopes_update`).

## 2. HTTP method

`POST` only. Any other method returns `405` with
`{ "ok": false, "error": { "code": "METHOD_NOT_ALLOWED", ... } }`.

## 3. Authentication

`authenticate.admin(request)` — the exact same Shopify session infrastructure every
other authenticated route in this app already uses (`app/routes/app.tsx`,
`app._index.tsx`, `app.additional.tsx`). This phase introduces no second auth
mechanism. A request without a valid embedded-app session token is rejected by that
existing middleware before this route's own code runs at all.

The calling shop comes from `session.shop` — **never** from the request body. See §8.

## 4. Request schema

JSON body, matching `CalculationInput` from `app/lib/pricing/types.ts` minus
`shopDomain` (the server supplies that — see §8):

```ts
{
  sku: string;                    // required
  quantity: number;                // required
  shopifyProductId?: string;       // optional — enables ProductPricingOverride lookup
  decoration?: {
    method: "SCREEN_PRINT" | "EMBROIDERY" | "DTF" | "DTG" | "VINYL" | "SUBLIMATION" | "OTHER";
    colors: number;
    locations: number;
    reverseSide: boolean;
    differentReverseArtwork: boolean;
    repeatOrder: boolean;
  };
  options?: Array<{ groupName: string; optionValueId: string }>;
  production?: { code?: string };  // an object — see note below
  packaging?: { code?: string };
}
```

**Note on `production`/`packaging`:** the Phase 2.4 brief's illustrative example used
`"production": "RUSH"` (a bare string). The real `ProductionSelectionInput` /
`PackagingSelectionInput` types are objects, `{ code?: string }` — this API follows the
actual type, not the illustrative example, per the brief's own instruction to inspect
`app/lib/pricing/types.ts` rather than copy the sketch blindly. A bare string for either
field is rejected with `400`.

Only request **shape** is validated here (right fields present, right JS types) — see
[`app/lib/pricing-api/request.ts`](../app/lib/pricing-api/request.ts). Business rules
("quantity must be positive," "this option belongs to this group," "this decoration
code exists for this profile") are the calculation engine's responsibility and are
never duplicated here.

## 5. Successful response

`200`, matching `PricingCalculationResult` verbatim — nothing is transformed,
recalculated, or rounded:

```json
{
  "ok": true,
  "data": {
    "source": { "storeId": "...", "shopDomain": "...", "pricingProfileId": "...", "pricingProfileSku": "LNY01", "resolvedVia": "sku" },
    "quantity": 1000,
    "quantityTier": { "id": "...", "minQuantity": 1000, "maxQuantity": 2999, "listUnitPriceCents": 164, "netUnitPriceCents": 98 },
    "base": { "quantity": 1000, "listUnitPriceCents": 164, "netUnitPriceCents": 98, "listSubtotalCents": 164000, "netSubtotalCents": 98000 },
    "decoration": { "method": "SCREEN_PRINT", "charges": [ /* itemized lines, list+net each */ ], "listChargesCents": 67000, "netChargesCents": 53600 },
    "options": { "selections": [ /* ... */ ], "chargesCents": 25 },
    "production": { "code": "RUSH", "isRush": true, "minBusinessDays": 5, "maxBusinessDays": 5, "relatedSku": "LNY5RSH01", "feeCents": null, "notes": null },
    "packaging": { "code": "STANDARD_CARTON", "unitsPerPackage": 250, "cartonWeightLbs": 8.5, "lengthIn": 12, "widthIn": 8, "heightIn": 6, "feeCents": null },
    "totals": { "listTotalCents": 233525, "netTotalCents": 153625 }
  }
}
```

## 6. Error response

```json
{
  "ok": false,
  "error": {
    "code": "QUANTITY_BELOW_MINIMUM",
    "message": "quantity 5 is below the minimum supported quantity 100"
  }
}
```

Boundary validation errors (`400`) additionally carry `issues`:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST_BODY",
    "message": "The request body is invalid.",
    "issues": [{ "path": "sku", "message": "sku is required and must be a non-empty string" }]
  }
}
```

An unexpected (non-`PricingError`) failure always becomes:

```json
{ "ok": false, "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred while calculating pricing." } }
```

— never the raw exception message, never a stack trace. See
[`app/lib/pricing-api/response.ts`](../app/lib/pricing-api/response.ts) and
`response.test.ts`, which asserts this directly (constructs an error containing a fake
credential/connection string and confirms it never appears in the response body).

## 7. HTTP status mapping

| Status | When |
|---|---|
| `200` | Calculation succeeded |
| `400` | Malformed JSON, or the body doesn't match the request schema (§4) |
| `401` / reauth redirect | Handled entirely by `authenticate.admin` before this route's code runs — see §3 |
| `404` | `StoreNotFound`, `PricingProfileNotFound`, `PricingProfileInactive` — nothing to price |
| `422` | Any other `PricingError` — the request was shaped correctly, but the pricing selection doesn't resolve (bad quantity, unknown option/production code, missing required option, etc.) |
| `500` | Anything not a `PricingError` — unexpected |

The full mapping is one function, `mapPricingErrorToStatus`, so this table can't drift
from the code.

## 8. Tenant resolution

```ts
const { session } = await authenticate.admin(request);
// ...
const result = await handlePricingApiRequest(prisma, session.shop, rawBody);
```

`handlePricingApiRequest` (`app/lib/pricing-api/handler.ts`) takes `shopDomain` as an
explicit function parameter, entirely separate from `rawBody` — there is no code path
anywhere in this module through which a value from the request body could become the
tenant. The request schema (§4) doesn't even have a `shopDomain`/`storeId` field to
send. This was verified directly: `handler.test.ts`'s tenant-isolation test seeds two
disposable stores with the *same* SKU and different prices, and confirms each
`shopDomain` gets only its own store's pricing.

## 9. Example LNY01 request

```http
POST /api/pricing HTTP/1.1
Authorization: Bearer <App Bridge session token>
Content-Type: application/json

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

Verified live (`handler.test.ts`) to return `totals: { listTotalCents: 233525,
netTotalCents: 153625 }` against the real seeded LNY01 profile — the exact figures
documented in `docs/pricing-engine.md` §12.

## 10. Example successful response

See §5 — that JSON is the real shape returned for the request in §9 (values
abbreviated for length; the actual `decoration.charges` array has one line per
matched `DecorationRule`).

## 11. Example validation error

Request: `{ "quantity": 5 }` (no `sku`, quantity type is fine but there's no product to
price against) →

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST_BODY",
    "message": "The request body is invalid.",
    "issues": [{ "path": "sku", "message": "sku is required and must be a non-empty string" }]
  }
}
```

with HTTP `400`. A shaped-correctly-but-unpriceable request, e.g. `{ "sku": "LNY01",
"quantity": 5 }` (below the lowest configured tier), instead returns `422` with
`error.code: "QUANTITY_BELOW_MINIMUM"` — verified directly in `handler.test.ts`.

## 12. How the storefront will eventually consume this

Not built in this phase (per the phase's stop conditions). The intended shape, once a
later phase builds it:

```
Shopify Storefront (product page)
        ↓
Theme extension JS  →  App Proxy route (NEW, not yet built)  →  same handlePricingApiRequest()
        ↓
Embedded Admin App  →  /api/pricing (THIS route, admin-session authenticated)
```

`/api/pricing` as built in this phase is reachable by the **embedded admin app**
(anything that can present a valid App Bridge session token) — e.g. a future admin
pricing-preview screen, or this project's own tests. It is *not* reachable by an
anonymous storefront visitor, and shouldn't be pointed at directly from theme/storefront
JavaScript — see §13.

## 13. App Proxy / storefront integration considerations

`shopify.app.toml` has no `[app_proxy]` section configured today (confirmed by
inspection before writing this route). A customer browsing the storefront product page
has no embedded-admin session token to present, so `authenticate.admin` cannot be the
auth path for that traffic. Making `/api/pricing` reachable from the live storefront
needs one of:

- **A separate App Proxy route** (e.g. `apps.pricing.calculate.tsx`, proxied through
  Shopify at a URL like `/apps/pricing/calculate`), authenticated with
  `authenticate.public.appProxy(request)` — Shopify signs and verifies these requests,
  so no bearer token from the browser is needed. This is the standard, safe pattern for
  storefront-callable app endpoints and is the recommended next step. It can call the
  exact same `handlePricingApiRequest` this route already uses (with `session.shop`
  from the app-proxy context instead), so no calculation logic would be duplicated.
- Configuring `[app_proxy]` in `shopify.app.toml` and requesting the relevant scope, if
  not already present.

**What was deliberately not done:** enabling `Access-Control-Allow-Origin: *` (or any
CORS) on `/api/pricing` to make it directly browser-callable from the storefront
origin. That would let any web page — not just this shop's storefront — call an
admin-session-gated endpoint's *shape*, and more importantly still wouldn't solve the
actual problem (a storefront visitor still has no valid App Bridge session token to
authenticate with). The App Proxy path above is the correct fix; a public CORS-enabled
endpoint reachable with just a shop domain string would not be.

## 14. Security considerations

Verified directly (see §8 and the Security Review below):

- The client cannot specify `storeId` or `shopDomain` — the request schema has no such
  field, and the tenant is always taken from the authenticated session.
- The client cannot submit a price — there is no price-shaped field anywhere in the
  request schema; every dollar amount in the response comes from
  `calculatePrice` → Prisma.
- Raw Prisma errors and stack traces are never returned (`response.test.ts` asserts
  this against a deliberately Prisma-connection-string-shaped error message).
- No Shopify API credentials or session tokens are echoed in any response.
- Authentication is not bypassable at this layer: `authenticate.admin` runs before any
  of this route's own code, and this phase adds no alternate auth path.

## Security review (Phase 2.4)

| Check | Result |
|---|---|
| Client cannot specify arbitrary `storeId` | ✅ no such field in the request schema |
| Client cannot specify arbitrary `shopDomain` | ✅ no such field; taken from `session.shop` |
| Client cannot bypass Shopify authentication | ✅ `authenticate.admin` runs first, unmodified |
| Client cannot submit/trust a price | ✅ no price field in the request; all prices from Prisma via `calculatePrice` |
| Raw Prisma errors not returned | ✅ `toErrorBody` only ever returns a `PricingError`'s own code/message, or the fixed `INTERNAL_ERROR` string |
| Stack traces not returned | ✅ verified in `response.test.ts` |
| No secrets/credentials exposed | ✅ response body is exactly `PricingCalculationResult`, which contains no credentials |
| No hardcoded prices | ✅ this route contains zero dollar-amount literals; `request.ts`/`response.ts`/`handler.ts` deal only in shapes and status codes |

**Production hardening deferred to a later phase (not implemented here, since the
existing project has no rate limiter and none was asked for):** request-rate limiting
per shop/session, and request-body size limits (an extremely large `options` array
could do more validation work than necessary, though it cannot cause unbounded
database work — `handlePricingApiRequest` performs a fixed, small number of queries per
request regardless of body size).
