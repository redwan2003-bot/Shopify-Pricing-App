# Pricing calculation engine (Phase 2.3)

This covers `app/lib/pricing/` — the engine that turns a product configuration into a
priced, itemized result using the data seeded in Phase 2.2. It assumes familiarity with
[`docs/pricing-architecture.md`](./pricing-architecture.md) (the schema and import
architecture); this document doesn't repeat that, only what's new.

No schema changes were needed for this phase — `prisma/schema.prisma` is unchanged from
Phase 2.2. Every field this engine reads already existed.

## 1. Architecture

```
Shopify Storefront / API route / admin tool / test   (a future phase — not built here)
              │
              ▼
     calculatePrice(prisma, input)        ← app/lib/pricing/index.ts (the one public entry point)
              │
   ┌──────────┴───────────┐
   ▼                       ▼
loadPricingContext    calculatePricingFromProfile
(repository.ts)       (calculator.ts)
   │                       │
Prisma (Store,        pure function — no I/O, no
PricingProfile,        randomness, no Date.now();
+ all children)         same input ⇒ same output
   │
Prisma Client (app/db.server.ts in real usage;
tests inject their own PrismaClient)
```

`repository.ts` and `calculator.ts` are deliberately separate, per the "database → repository →
validated data → pure calculator → result" shape this phase asked for: the repository
does every Prisma call and maps Prisma's payload shape down to a plain
`PricingProfileData` (see types.ts); the calculator only ever sees that plain shape, so
it can be unit-tested with hand-built fixtures and no database at all
(`calculator.test.ts`).

## 2. Input structure

```ts
interface CalculationInput {
  shopDomain: string;        // Store's real external key — see §10
  sku: string;
  shopifyProductId?: string | null; // enables ProductPricingOverride — see §9
  quantity: number;
  decoration?: DecorationSelectionInput;
  options?: OptionSelectionInput[];
  production?: ProductionSelectionInput;   // { code? }
  packaging?: PackagingSelectionInput;     // { code? }
}
```

Two deliberate departures from the phase's sketch input, both because the actual
schema's real unique keys don't match the sketch's `storeId`/`groupCode`/`valueCode`:

- **`shopDomain`, not `storeId`.** `Store.id` is an internal cuid a caller wouldn't
  naturally have. `Store.shopDomain` is the real external unique key — and it's already
  the convention `app/lib/pricing-import` uses. `calculatePrice` still resolves and
  scopes every query by the internal `storeId` underneath (see §10); only the *input*
  field changed.
- **Option selection is `{ groupName, optionValueId }`, not `{ groupCode, valueCode }`.**
  `OptionValue.code` is not unique — LNY01's real seed data reuses codes across
  distinct items (e.g. `"SA04"` labels both "Keyring" and "Non-swivel Bulldog"; `"BK09"`
  labels four different items). `OptionGroup.name` and `OptionValue.id` are the schema's
  actual unique keys, so those are what selection uses. Requiring both the group name
  *and* the value id (rather than just the id) is what makes "option belongs to the
  wrong group" a real, checkable error — see §5.

`quantity`, `production`, and `packaging` are otherwise as sketched.

## 3. Quantity tier selection

**Rule:** the highest `QuantityTier` whose `minQuantity` is `<=` the requested quantity.
`maxQuantity` is informational only (used for reporting, e.g. a UI showing tier
boundaries) — it never affects which tier is chosen.

| quantity | tier selected |
|---|---|
| 100 | 100 |
| 300 | 300 |
| 750 | 500 |
| 1000 | 1000 |
| 2500 | 1000 |
| 5000 | 5000 |
| 7500 | 5000 (highest tier still applies above its own range) |
| 50 | **error** — `QuantityBelowMinimum` |

A profile with zero `QuantityTier` rows throws `QuantityTierNotFound` rather than
falling back to any price.

## 4. List vs. net pricing

Never collapsed. `QuantityTierResult`, `BasePriceResult`, and every
`DecorationChargeLine` carry both `list*Cents` and `net*Cents` independently, and
`totals` reports both `listTotalCents` and `netTotalCents`. Which one a caller shows a
given customer is a decision for the (not-yet-built) storefront/API layer, not this
engine.

The one exception: `OptionsResult.chargesCents` is a single number, because
`OptionValue.priceAdjustmentCents` and `OptionGroup.categoryPriceAdjustmentCents` are
themselves single fields in the schema (the source sheet never gave separate list/net
prices for attachments/features) — that one adjustment is added to both
`totals.listTotalCents` and `totals.netTotalCents` identically.

## 5. Decoration calculation

`resolveDecoration` (in `calculator.ts`) maps configuration inputs to `DecorationRule`
rows via a small, documented code table:

| input condition | `DecorationRule.code` required |
|---|---|
| always (base configuration) | `SETUP_1C1L` |
| `colors > 1` | `ADDL_COLOR_SETUP` **and** `ADDL_COLOR_RUN` |
| `locations === 2` | `SECOND_LOCATION_RUN` |
| `reverseSide && differentReverseArtwork` | `REVERSE_SIDE_SETUP` |
| `repeatOrder` | `REPEAT_ORDER_SETUP` |

Each matched rule becomes one `DecorationChargeLine`, using `chargeBasis` to decide how
many times its price applies: `ONE_TIME` → once (`occurrences: 1`); `PER_UNIT` → once
per unit (`occurrences: quantity`). All six line amounts (list and net) come from the
matched `DecorationRule` row — nothing is hardcoded in the engine except the *code
strings* above, which name which database rows mean what. That's the explicit
allowance in the phase brief ("rules may be identified using their existing database
codes"), not a price table.

If a condition is triggered but the matching code doesn't exist on the profile (e.g. a
future product configured without a `SECOND_LOCATION_RUN` rule, but a caller requests
`locations: 2`), the engine throws `DecorationRuleNotFound` rather than skipping the
charge or charging $0.

**Two interpretation calls, made explicit because the data doesn't fully resolve them:**

1. **No per-additional-color multiplier.** `chargeBasis` only distinguishes "once per
   order" from "once per unit" — it has no third axis for "once per additional color."
   So `colors: 3` triggers `ADDL_COLOR_SETUP`/`ADDL_COLOR_RUN` exactly the same as
   `colors: 2` (a binary gate: 2+ colors turns the rule on; it isn't multiplied by how
   many colors beyond the first). Real screen-print shops often charge per additional
   color, not a flat "any additional colors" fee — but encoding that would mean
   inventing a multiplier dimension the schema doesn't have. If that's actually needed,
   it's a `DecorationRule` schema addition (e.g. a `perAdditionalUnit` flag), not
   something this engine should quietly assume.
2. **`locations` and `reverseSide`/`differentReverseArtwork` are independent axes.**
   The source sheet prices "2nd Location Run Charge" and "Reverse Side Setup" as two
   separate line items, so the engine treats them as two separate, independently-gated
   conditions, exactly as named. Whether "the reverse side" and "a second location" are
   the same physical placement in ImprintID's actual production process is a business
   question this phase doesn't answer — the engine prices exactly the line items the
   database defines.

`locations > 2` is rejected outright (`InvalidDecorationSelection`) — no rule exists
past a second location in the current data, so there's nothing to price it with.

## 6. Option calculation

For each `{ groupName, optionValueId }` selection: the group is looked up by name; the
value is looked up **across the whole profile** by id (not scoped to the stated group)
so that a value belonging to a *different* group is a distinguishable, specific error
(`OptionValueGroupMismatch`) rather than a generic "not found."

Price precedence, matching exactly how Phase 2.2 structured the data:

1. `OptionValue.priceAdjustmentCents`, if not `null` → `source: "option"`.
2. Else `OptionGroup.categoryPriceAdjustmentCents`, if not `null` → `source: "category"`.
3. Else → `OptionPricingUnavailable`. **Never** silently charged as `$0` — a `null` in
   either field means "no price was supplied," not "free" (Phase 2.2's own
   distinction; see `docs/pricing-architecture.md` §7).

Two selections for the same group are rejected (`DuplicateOptionSelection`) — a
customer picks one attachment style, not two. A group with `isRequired: true` and no
matching selection is rejected (`MissingRequiredOptionGroup`) — supported by the schema
today, though no LNY01 group currently sets it.

## 7. Production calculation

`production.code`, if given, must match a `ProductionRule.code` on the profile
(`ProductionRuleNotFound` otherwise). If omitted, the engine defaults to the profile's
single non-rush (`isRush: false`) rule — if there isn't exactly one, omitting `code` is
itself an error (`ProductionRuleNotFound`, forcing an explicit choice rather than
guessing). The full rule (`minBusinessDays`, `maxBusinessDays`, `relatedSku`,
`feeCents`, `notes`) is returned as-is; a `null` `feeCents` contributes `0` to the
totals but is reported as `null` (not `0`) so a UI can show "no rush surcharge" instead
of "$0.00 surcharge."

## 8. Packaging

Not user-selected pricing the way decoration/options/production are — packaging
information is attached to every calculation automatically. If the profile has exactly
one `PackagingRule`, it's used; if it has more than one, `packaging.code` must
disambiguate; if it has none, `packaging` is `null` in the result (not an error — not
every product needs packaging data recorded yet). A configured `feeCents`, if present,
is added to both totals the same way a production fee is; `null` again means "no fee
supplied," contributing `0` but reported distinctly. Dimensions/weight are exposed for
the future shipping layer to use — this engine performs no shipping calculation.

## 9. Override precedence

```
shopifyProductId given?
   │
   ├─ no  → resolve PricingProfile by (store, sku)              [resolvedVia: "sku"]
   │
   └─ yes → look up ProductPricingOverride by (store, shopifyProductId)
              │
              ├─ not found            → resolve by (store, sku)  [resolvedVia: "sku"]
              ├─ found, isActive=false → PricingConfigurationInvalid
              ├─ found, no pricingProfileId → resolve by (store, sku) [resolvedVia: "sku"]
              └─ found, pricingProfileId set → use that profile  [resolvedVia: "override"]
                   (after confirming it belongs to the same store)
```

LNY01 has zero `ProductPricingOverride` rows today (no known Shopify product ID), so in
practice every real LNY01 calculation resolves via the `sku` branch. The `override`
branch is fully implemented and exercised in `tenant.test.ts` against a synthetic
override row, so a future step — creating the real override once LNY01's Shopify
product exists — needs no engine changes.

## 10. Store isolation

`loadPricingContext` never queries `PricingProfile` by `sku` alone — every query is
scoped through the resolved `store.id` first (`findUnique({ where: { storeId_sku: ... } })`
uses the compound unique key, not a bare `sku` filter). `tenant.test.ts` proves this
directly: two disposable stores are seeded with the *same* SKU and deliberately
different prices, and the engine is shown to return each store's own price, never the
other's.

## 11. Error handling

Every failure is a typed subclass of `PricingError` (see `errors.ts`), each with a
stable `code` string for a future API to map to an HTTP status without parsing message
text: `StoreNotFound`, `PricingProfileNotFound`, `PricingProfileInactive`,
`InvalidQuantity`, `QuantityTierNotFound`, `QuantityBelowMinimum`,
`InvalidDecorationSelection`, `DecorationRuleNotFound`, `InvalidOptionGroup`,
`InvalidOptionValue`, `OptionValueGroupMismatch`, `DuplicateOptionSelection`,
`MissingRequiredOptionGroup`, `OptionPricingUnavailable`, `ProductionRuleNotFound`,
`PricingConfigurationInvalid`. None of these ever get replaced with a guessed or
zeroed-out price — a raised error is always the alternative to an invented number.

## 12. Example calculation

LNY01, quantity 1000, 2 colors, 2 locations, different reverse artwork, repeat order, a
"Cell Phone Loop" option, rush production (this exact scenario is asserted against the
live database in `lny01.test.ts`):

```
Base (1000 tier)             list $164.00 × 1000 = $1,640.00   net $98.00 × 1000 = $980.00
Setup (1 color, 1 location)  list  $45.00                      net  $36.00
Additional color setup       list  $35.00                      net  $28.00
Additional color run         list   $0.25 × 1000 = $250.00     net   $0.20 × 1000 = $200.00
2nd location run             list   $0.30 × 1000 = $300.00     net   $0.24 × 1000 = $240.00
Reverse side setup           list  $40.00                      net  $32.00
Repeat order setup           list  $25.00                      net  $20.00
Cell Phone Loop option                       $0.25 (both)
Rush production                              — (no fee configured)
Packaging (standard carton)                  — (no fee configured)
──────────────────────────────────────────────────────────────────────────
Total                        list $2,335.25                    net $1,536.25
```

## 13. Calling the engine from a future API

```ts
import prisma from "~/db.server"; // the app's shared PrismaClient singleton
import { calculatePrice } from "~/lib/pricing";

const result = await calculatePrice(prisma, {
  shopDomain: session.shop, // from authenticate.admin(request) / a storefront session
  sku: "LNY01",
  quantity: 1000,
  decoration: { method: "SCREEN_PRINT", colors: 2, locations: 1, reverseSide: false, differentReverseArtwork: false, repeatOrder: false },
  options: [{ groupName: "Optional Features", optionValueId }],
});
```

Catch `PricingError` (or a specific subclass) to turn a calculation failure into a
client-facing response; every other error is unexpected and should propagate. No
calculation logic needs to move into the API route — the route only translates
HTTP ↔ `CalculationInput`/`PricingCalculationResult`/`PricingError`.

## Deferred (not built in this phase)

Storefront pricing UI, theme extension, the actual pricing API route, cart/checkout
integration, Shopify Functions, an admin pricing dashboard, shipping-cost calculation
from packaging dimensions, and the real `ProductPricingOverride` row for LNY01 (blocked
on a real Shopify product ID existing in the dev store). Per-additional-color
multiplication for decoration charges (see §5) is also deferred — it would need a
schema addition, not just engine logic.
