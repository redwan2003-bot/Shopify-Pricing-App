# Production Database Readiness

Performed 2026-09-25. **Scope limit up front:** this environment has no credentials for Render's
production Postgres — everything under "Local database findings" below is checked against the
local SQLite copy only and must not be read as a statement about production. Everything under
"Cannot be checked from here" is a real gap, not an oversight.

## Local database findings (SQLite, `prisma/dev.sqlite`)

**The offline session for `imprintid-pricing-dev.myshopify.com` expired 2026-09-22.** The most
recent full CSV re-import ran 2026-09-23 (`PricingProfile.updatedAt` range confirms this) — one
day *after* the session expired. `editAction`'s relink step runs `buildLinkReport` +
`applyLinkReport` against the live Admin API immediately after every save/import; with no valid
session, that call fails and is caught (see `app/lib/pricing-editor/editor-route.server.ts`, the
`relink after save failed` catch) — the import itself was **not** blocked, but linking silently
did not happen.

Result: of 147 pricing profiles for that store, only **1** shows an active
`ProductPricingOverride` row locally, and that single row's `shopifyProductId` is a bare numeric
string (`"8438071820427"`), not the `gid://shopify/Product/...` format the current linking code
in `app/lib/pricing-import/link-products.ts` produces and expects everywhere else. That row
predates 2026-09-22 and looks like a leftover from before a schema/format change — it should be
treated as suspect, not as evidence the linking pipeline works end-to-end.

**This directly contradicts the "145 linked / 2 held back" figure recorded from the 2026-09-23
verification session.** That figure was almost certainly correct *at the time*, against whatever
database that verification session was actually pointed at with a still-valid session — but it
cannot be re-derived from the current local database, and there is no way from this environment
to confirm whether it still holds for Render's production database either.

**MANUAL ACTION REQUIRED:** before launch, obtain a fresh Admin session for the target store
(dev store for continued testing, and separately the production database once seeded) and re-run
the link report (`npm run catalog:link -- --check` then `npm run catalog:link`, per
`docs/PRODUCTION_DEPLOYMENT.md`) to get a verified-current linked/unlinked count. Do not trust
the 2026-09-23 number for a go/no-go decision without re-running this.

## CSV held-back reasons (123 SKUs, from `imprintid_catalog_shopify_import_updated.csv`)

Re-run via `node --experimental-loader=./scripts/resolve-ts-loader.mjs scripts/import-catalog-pricing.ts imprintid_catalog_shopify_import_updated.csv --dry-run`
(read-only, nothing written). Every held-back SKU has a specific, non-generic reason — this is
the importer's validation working as designed, not a bug:

| Reason | Count | What it means | Fix path |
|---|---:|---|---|
| `sync status is "partial_no_quantity_tiers"` | 83 | Source data has a pricing record for this SKU but no quantity-tier pricing rows | Needs quantity-tier prices added at the source, or entered directly in the new pricing-profile editor |
| `sync status is "ready_derived_family_match"` | 24 | This SKU's pricing was derived by matching it to a "family" SKU, not an exact source match — held back so a human confirms before it's trusted | Review and either confirm (re-run import) or price directly in the editor |
| `sync status is "review_scaled_to_existing_price"` | 9 | Pricing was scaled from an existing price, flagged for review before trusting | Review and confirm, or edit directly |
| `no packagingRules in source JSON` | 3 | Missing packaging data required by the schema | Add packaging data at the source, or use the editor (which now defaults new profiles to a standard carton) |
| `unrecognized decoration method "Set-Up"` (group `set_up`) | 2 | The CSV's decoration-method label doesn't map to one of this app's `DECORATION_METHODS` | Either fix the source label or add the method by hand in the editor (note: adding *new* decoration methods was explicitly excluded from the editor's first-cut scope — this would need scope expansion or a source-data fix) |
| header/parsing line offset | 2 | Two SKUs' entries fell on the same output lines as the header during extraction in this audit — verified individually below | — |

The 2 "header line" rows are real held-back SKUs, not an artifact:
`LPUS34KR` and `LPUS34` (USA Made Polyester Lanyard variants), both `partial_no_quantity_tiers`.
83 + 24 + 9 + 3 + 2 + 2 = 123, matching the importer's own count exactly.

**None of the 123 are import bugs.** They're all legitimate holds per the app's own stated design
("held back with a reason; nothing is imported by guessing" — `app/lib/pricing-import/catalog-csv.ts`).
The bulk (107 of 123) need quantity-tier data that doesn't exist yet in the source CSV; the
editor built in this pass is the intended tool to fill these in by hand, one at a time.

## Cannot be checked from here (needs production credentials)

- Render Postgres connection, migration status, schema version.
- Whether the production database has been seeded at all (per project memory, this was already
  flagged as unverified before this session).
- Required indexes/constraints in the deployed Postgres (schema drift check only confirms the
  *schema file* matches SQLite's; it does not confirm a migration was actually applied in Render).
- Whether any development/test data exists in production.
- Backup/recovery procedure for Render's managed Postgres — not documented in this repo; confirm
  Render's plan-level backup retention in the Render dashboard.
- Real linked/unlinked SKU counts against production (see above).

## Cross-shop isolation (the one thing that *is* verified)

Live-tested in this session (`scripts/_editor-live.mjs`): a pricing profile belonging to another
shop 404s on load and is refused on save ("This pricing profile no longer exists.") when accessed
under a different shop's session token. Every list/search/edit/save query is scoped by
`storeId`/`shopDomain`. This is the one item from the plan's "Shop A / Shop B" test that this
environment could actually exercise without a second real store — it passed.
