# Dynamic pricing — data architecture (Phase 2.2)

This covers the pricing database layer added in Phase 2.1 (schema) and Phase 2.2
(restructure + seed/import). It does **not** cover a calculation engine, storefront UI,
or Shopify integration — those are later phases (see "Deferred to Phase 2.3+" below).

## 1. Architecture

```
Store (one per Shopify shop)
  └── PricingProfile (one per priced product, identified by sku)
        ├── QuantityTier[]      — quantity-break list/net prices
        ├── DecorationRule[]    — structured decoration charges (screen print, etc.)
        ├── OptionGroup[]       — selectable option categories
        │     └── OptionValue[] — individual selectable options
        ├── ProductionRule[]    — turnaround options (standard/rush)
        └── PackagingRule[]     — carton/packaging physical data

ProductPricingOverride — links a real Shopify product to a PricingProfile once the
Shopify product ID is known. Not populated for LNY01 yet (see §9).
```

All of this lives in `prisma/schema.prisma`, using the existing Prisma + SQLite setup
already used for Shopify session storage (`Session` model, untouched). No second
database or Prisma client was introduced.

## 2. Database relationships

- `Store.shopDomain` is unique — one row per installed shop.
- `PricingProfile` belongs to a `Store`. `(storeId, sku)` is unique, so a profile can be
  looked up by SKU before it has a Shopify product ID. `(storeId, name)` is also unique
  (a human-readable identity, e.g. for profiles not tied to one SKU).
- Every child table (`QuantityTier`, `DecorationRule`, `OptionGroup`, `ProductionRule`,
  `PackagingRule`) has `pricingProfileId` with `onDelete: Cascade`, and a `(pricingProfileId,
  <key>)` unique constraint (`minQuantity`, `code`, `code`, `code`, `code` respectively)
  that both prevents duplicates and is the idempotent-import key.
- `OptionValue` belongs to `OptionGroup`, cascades on delete, and is unique per
  `(optionGroupId, label)` — not per `code`, because the source catalog reuses vendor
  codes across distinct labeled items (see §3).
- `ProductPricingOverride` belongs to `Store` and optionally to a `PricingProfile`
  (`onDelete: SetNull`, so deleting a profile doesn't delete the override row). Unique
  per `(storeId, shopifyProductId)`.

## 3. LNY01 seed data

SKU `LNY01`, "1\" Nylon Lanyards", Screen Print pricing. Source data and every
interpretation decision (standard-vs-premium attachment pricing, duplicate vendor
codes, the unexplained "V" suffix on Optional Features prices) is documented in
[`prisma/seed-data/README.md`](../prisma/seed-data/README.md). The data itself is in
[`prisma/seed-data/lny01.ts`](../prisma/seed-data/lny01.ts).

Seeded result (verified against the actual database, not just script output):

| Table | Count |
|---|---|
| Store | 1 |
| PricingProfile | 1 |
| QuantityTier | 6 |
| DecorationRule (screen print) | 6 |
| OptionGroup | 6 (5 attachment categories + Optional Features) |
| OptionValue | 27 |
| ProductionRule | 2 (STANDARD, RUSH) |
| PackagingRule | 1 |
| ProductPricingOverride | 0 (LNY01 has no known Shopify product ID yet) |

## 4. Import structure

`app/lib/pricing-import/` is a standalone, reusable module — nothing in it is specific
to LNY01:

- `types.ts` — `PricingProfileImportInput` and friends: the normalized shape any
  product's pricing package must be in before import.
- `validate.ts` — `validatePricingProfileImport(input)`. Pure function, no I/O. Returns
  `{ valid, errors }` with every problem found (not just the first), each with a
  `path` and `message`. Covers: SKU/store required, positive integer quantities, no
  duplicate quantity tiers, integer-cents-only money with no negatives, net price not
  exceeding list price, valid decoration method/charge-basis enum values, unique
  decoration/production/packaging codes, unique option group names and option labels,
  valid production lead-time ranges, valid packaging dimensions.
- `import.ts` — `importPricingProfile(prisma, input)`. Throws
  `PricingImportValidationError` (with `.issues`) if validation fails — nothing is
  written to the database in that case. Otherwise runs the whole import in one
  `prisma.$transaction`. See §8 for exactly how idempotency works.
- `index.ts` — barrel export of the above.

This is intentionally the seam for a future CSV/JSON importer: something that parses a
source file only needs to produce a `PricingProfileImportInput[]` and call
`importPricingProfile` per product. No admin UI or Shopify integration was built in
this phase (out of scope — see §10).

## 5. How to run the seed

```sh
npx prisma db seed
# or
npm run db:seed
```

Seeds (or re-seeds) LNY01 for the shop domain in `SEED_SHOP_DOMAIN`, defaulting to
`imprintid-pricing-development.myshopify.com` (`prisma/seed.ts`) if that env var isn't
set. The default is a fallback value in the seed script, not something baked into the
schema — every pricing row is still keyed off a normal `Store.shopDomain` value.

## 6. How to add another product

1. Add a new file under `prisma/seed-data/`, e.g. `some-sku.ts`, exporting a function
   that returns a `PricingProfileImportInput` (mirror `lny01.ts`).
2. Call `importPricingProfile(prisma, buildYourInput(shopDomain))` — from `seed.ts`, a
   script, or (in a later phase) an admin route/CLI.
3. Nothing else needs to change. The importer and validator are product-agnostic.

## 7. Money representation

Every monetary field is an `Int` counted in **cents** (e.g. `$1.37` → `137`). There is
no `Float`/`Decimal` money field anywhere in the pricing schema, and the validator
rejects any non-integer numeric value passed to a `*Cents` field. `QuantityTier` and
`DecorationRule` each store both `listPriceCents` and `netPriceCents` — the schema never
collapses these into one price, since which one applies is a future pricing-engine
decision, not a data-entry one.

A `*Cents` field that is genuinely unset (no rush surcharge was supplied, no packaging
fee was supplied, no price given for a specific attachment) is stored as SQL `NULL`
(`Int?` in Prisma), never defaulted to `0`. `0` always means "confirmed to cost
nothing." This distinction is why `OptionValue.priceAdjustmentCents`,
`ProductionRule.feeCents`, and `PackagingRule.feeCents` are nullable with no default —
see the field comments in `prisma/schema.prisma` for the reasoning on each.

Non-money physical measurements (`PackagingRule.cartonWeightLbs`, `lengthIn`, `widthIn`,
`heightIn`) use `Float`, since they aren't money and the float-safety requirement is
specific to currency.

The rest of the app (`app/routes/app._index.tsx`) has one pre-existing, unrelated use of
a decimal-looking string: it passes `price: "100.00"` as a literal to a Shopify GraphQL
mutation (`productVariantsBulkUpdate`) in the app template's demo "generate a product"
button. That's the Shopify Admin API's own string-typed `Money` scalar format for a
one-off demo mutation — it doesn't touch this database, isn't part of the pricing
system, and wasn't changed.

## 8. Idempotency behavior

`importPricingProfile` is safe to run any number of times with the same input:

- `Store` is `upsert`d by `shopDomain`.
- `PricingProfile` is `upsert`d by `(storeId, sku)` — same profile row (same id) every
  run.
- Every child collection (quantity tiers, decoration rules, option groups + their
  values, production rules, packaging rules) is **replaced in place**: all existing
  rows for that `pricingProfileId` are deleted, then the current input's rows are
  created, inside the same transaction as the profile upsert.

This was chosen over per-row upserts because it guarantees the database always exactly
matches the current input — a corrected price in the source data is reflected on
re-import, not left stale next to a new row. The tradeoff is that child row IDs are not
stable across re-imports; nothing in this phase depends on a child row's ID surviving a
re-import, so that's an acceptable tradeoff, not a hidden cost. Verified directly (see
final report): running the LNY01 seed twice left exactly 1 `PricingProfile`, 6
`QuantityTier`, and 27 `OptionValue` rows — not 2x.

## 9. Shopify product linking strategy

LNY01 does not have a known Shopify product ID in this environment
(`imprintid-pricing-development.myshopify.com`), and the instructions for this phase
were explicit: don't invent one. So:

- `PricingProfile.sku` (`"LNY01"`) is the lookup key for now.
- `ProductPricingOverride` (unchanged in this phase, still available, still unused for
  LNY01) is the intended link once the real product exists: it has `shopifyProductId`
  (required — Shopify remains the source of truth for the product itself) and an
  optional `pricingProfileId`. When the LNY01 product is created in the dev store, a
  future step creates one `ProductPricingOverride` row tying that product's real
  Shopify ID to the existing `PricingProfile` found via `sku: "LNY01"` — no pricing data
  needs to move or be re-entered.
- Shopify product **handle** was called out in the phase instructions as another
  possible linking key. The current schema only stores `shopifyProductId` on
  `ProductPricingOverride`; a handle lookup would go through the Shopify Admin API using
  that ID (handles can change; IDs don't), so no separate `shopifyProductHandle` column
  was added — this was a deliberate "don't add a constraint/column that isn't yet
  needed" call, not an oversight. Flag this if a handle-based lookup turns out to be
  needed before the ID is known.

## 10. Deferred to a later phase

Per the phase instructions, none of the following were built, and none should be
inferred from what exists:

- Pricing calculation engine (combining quantity tier + decoration + options + rush
  into a final order price)
- Storefront pricing UI / product-page calculator
- Shopify theme extension
- Cart or checkout pricing logic, Shopify Functions
- Admin pricing dashboard / customer-facing configuration UI
- Shipping-cost calculation from `PackagingRule` dimensions
- The actual `ProductPricingOverride` row for LNY01 (blocked on a real Shopify product
  ID existing in the dev store)
