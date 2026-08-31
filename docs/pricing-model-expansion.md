# Pricing model expansion (Phase 2.7)

Extends the Phase 2.2–2.6 pricing architecture to represent richer promotional-product
catalog structures (product colors, attachments as a distinct concept, per-color
decoration pricing, price codes) — inspired by, not copied from, a Sage-style catalog
page. This document distinguishes three kinds of statement throughout:

- **SOURCE-DERIVED FACT** — directly observed in LNY01's Phase 2.2 source sheet or the
  Sage reference page.
- **IMPLEMENTATION DECISION** — a deliberate architectural choice made in this phase.
- **ASSUMPTION** — something inferred where the source didn't state it directly, flagged
  as such rather than presented as fact.

## 1. Why Phase 2.7 exists

The Phase 2.3–2.6 architecture could price LNY01 correctly, but two of its modeling
choices didn't generalize to other promotional products: "additional colors" was a
binary on/off gate rather than a per-color-number price table, and "attachment" only
existed as an unlabeled `OptionGroup` indistinguishable from any other option group.
This phase makes both dimensions explicit and adds two entirely new ones (product color,
price code) that LNY01's source data never needed but a broader catalog will.

## 2. Sage reference analysis

**SOURCE-DERIVED FACT:** `https://www.sagewebsitestandard.com/p/HZLLF-LNADX/1-polyester-lanyard-25-mm`
was fetched (via this session's web-fetch tool) at the start of this phase. The page
returned only: the product title ("1\" Polyester Lanyard (25 MM)"), site navigation
(`Office > Tradeshows & Events > Lanyards`), and generic header/footer/contact content.
**No color list, no attachment list, no decoration pricing, no quantity breaks, no price
codes, and no per-unit or setup charges were present in the fetched content** — it
resolved to a shell/category-style page, not a populated product-detail view (likely
requiring JavaScript rendering or an authenticated session this tool doesn't have).

Because of this, **no numeric value, color name, attachment name, or price code
anywhere in this phase's seed data was sourced from Sage.** The Sage URL served only as
the conceptual prompt for which dimensions a promotional-product catalog needs to
represent (colors, attachments, per-color decoration pricing, price codes,
quantity breaks) — the *shape* of the requirement, not any of its values. Every actual
number in this phase's LNY01 data continues to come from the same Phase 2.2 source
sheet as before.

## 3. Current model limitations (before this phase)

- `DecorationRule` could only express "colors > 1 → one flat charge," not "color 2 costs
  X, color 3 costs Y."
- `OptionGroup` had no way to say "this group is an Attachment" versus any other kind of
  option group, other than reading its `name` string.
- No concept of product color existed at all.
- No concept of a vendor/price-sheet reference code ("price code") existed anywhere.

## 4. New model

```
PricingProfile
 ├── QuantityTier[]                        (unchanged structurally; + priceCode)
 ├── ProductColor[]                        NEW
 ├── DecorationRule[]                      (+ priceCode; ADDL_COLOR_* rules removed)
 ├── DecorationColorCharge[]               NEW — per (method, colorNumber, chargeBasis)
 ├── OptionGroup[]                         (+ kind: GENERIC | ATTACHMENT | FEATURE)
 │     └── OptionValue[]                   (+ code, priceCode)
 ├── ProductionRule[]
 ├── PackagingRule[]
 └── ProductPricingOverride                (unchanged)
```

**IMPLEMENTATION DECISION:** Attachments were *not* given a separate table. LNY01's
attachment data was already fully and correctly represented by `OptionGroup`/
`OptionValue` (5 groups, category- and value-level pricing already working). Duplicating
that into a new `Attachment` model would have created two sources of truth for the same
data. Instead, `OptionGroup.kind` was added so the catalog API (and any future code) can
tell an Attachment group apart from a generic one structurally, without ever adding
attachment rows to a second table.

**IMPLEMENTATION DECISION:** Product color *was* given a separate table
(`ProductColor`), because — unlike Attachment — no existing structure represented it at
all, and color is a near-universal physical-product dimension with its own identity (a
stable `code`), not an arbitrary merchant-named option group. Kept intentionally
minimal: no hex/swatch metadata, since nothing sources or consumes one yet (see §5).

**IMPLEMENTATION DECISION:** No Cartesian pricing matrix was introduced. Quantity ×
color × attachment × decoration-color-count × production all remain independently
priced dimensions that sum together in the calculator (see §10), exactly as the phase's
own "Sage-compatibility design principle" section asked for — not a giant combination
table.

## 5. Product colors

`ProductColor { id, pricingProfileId, code, name, priceCode, priceAdjustmentCents,
sortOrder, isActive }`. `priceAdjustmentCents` is nullable with no default — null means
"no price was supplied" (never treated as $0), matching the exact convention
`OptionValue` already established in Phase 2.2. An inactive color is excluded from
selection entirely, behaving identically to a color that was never configured
(`ProductColorNotFound` either way) — the same pattern `PricingProfileInactive` already
uses one level up.

**ASSUMPTION / SOURCE-DERIVED FACT:** LNY01's real seed data has **zero** `ProductColor`
rows. No color data exists in the Phase 2.2 source sheet, and Sage returned nothing
usable (§2) — so none was invented. The capability is fully implemented and covered by
tests using synthetic fixtures and a disposable "SAGE-DEMO" profile (see §17), not by
guessed LNY01 values.

## 6. Attachments

Unchanged data model (`OptionGroup`/`OptionValue`), now carrying `kind: ATTACHMENT` on
LNY01's five "Attachment — *" groups and `kind: FEATURE` on "Optional Features." No
migration of the underlying rows, no new codes, no new prices — the seed change was
exactly one field added per existing group. Selection is unchanged: still
`options: [{ groupName, optionValueId }]`, so no second selection mechanism was
introduced (an explicit phase requirement).

## 7. Price codes

A `priceCode` is **metadata identifying a row in an external vendor price sheet** (e.g.
a Sage-style price-grid column reference like `"A"` or `"P2"`) — it is never the price
itself, never used in any arithmetic, and never trusted from a client request (nothing
in `CalculationInput` accepts a `priceCode` at all — it's output-only). Added as a
nullable `String?` to `QuantityTier`, `DecorationRule`, `DecorationColorCharge`,
`OptionValue`, and `ProductColor` — the five models the phase's own list named that
correspond to one specific priced thing.

**IMPLEMENTATION DECISION — where `priceCode` was deliberately *not* added:**
`ProductPricingOverride` operates at the profile-selection level (which `PricingProfile`
a Shopify product uses), not at one specific price point, so a single `priceCode` there
wouldn't have unambiguous meaning — skipped, as the phase explicitly allowed ("do not
blindly add priceCode everywhere").

**SOURCE-DERIVED FACT:** every `priceCode` for LNY01's real data is `null` — none was
ever given in the source sheet. Synthetic tests (fixtures and the "SAGE-DEMO" profile)
populate it (e.g. `"P1"`, `"P2"`) to prove it's genuinely persisted, validated, and
returned by the catalog API without being fabricated for LNY01 itself.

## 8. Per-color decoration pricing

`DecorationColorCharge { pricingProfileId, method, colorNumber, chargeBasis, priceCode,
listPriceCents, netPriceCents, isActive }`, unique per `(pricingProfileId, method,
colorNumber, chargeBasis)`. `colorNumber` starts at 2 — color 1 is always covered by the
method's base setup rule (e.g. `SETUP_1C1L`), matching how the source sheet itself only
ever prices "the first color" implicitly via the base setup and "additional colors"
explicitly. `chargeBasis` reuses the existing `DecorationChargeBasis` enum
(`ONE_TIME`/`PER_UNIT`) rather than a new one — the semantics are identical, so a second
enum would have been a pure duplicate.

The calculator (`resolveAdditionalColorCharges` in `calculator.ts`) loops
`colorNumber` from 2 up to the requested color count and looks up that exact
`(method, colorNumber)` pair each time — summing whatever rows exist. Requesting a color
count beyond what's configured throws `ColorPricingUnavailable` rather than skipping the
charge or inventing a formula.

**Example** (synthetic fixture, `calculator.test.ts` "per-color decoration pricing"):
colors 2, 3, and 4 configured at $35/$32/$28 (list) one-time setup and $0.25/$0.30/$0.35
(list) per-unit run respectively; requesting 4 colors produces **six** separate charge
lines (`COLOR_2_SETUP`, `COLOR_2_RUN`, `COLOR_3_SETUP`, `COLOR_3_RUN`, `COLOR_4_SETUP`,
`COLOR_4_RUN`) plus the base setup — never one flat "additional colors" number.

## 9. Quantity pricing

**No structural change.** `QuantityTier` keeps `minQuantity`/`maxQuantity`/
`listPriceCents`/`netPriceCents` exactly as before, plus the new nullable `priceCode`.
Tier selection is unchanged: highest `minQuantity` ≤ requested quantity — verified not
to have changed by the LNY01 regression tests (§17) and a dedicated
"priceCode is passed through as metadata, never used as a price" test.

## 10. Calculation flow

`calculatePrice → loadPricingContext → calculatePricingFromProfile → PricingCalculationResult`
is unchanged structurally. Two additions inside `calculatePricingFromProfile`:
`resolveProductColor` (mirrors `resolveProduction`'s "look up by code, active rows only"
shape) and the per-color loop inside `resolveDecoration` (replacing the old binary
gate). Both contribute their cents to `totals` exactly like every other line item — nothing
is silently merged into an opaque number; `PricingCalculationResult.productColor` and
`.decoration.charges[]` remain individually inspectable.

The pure calculator still never queries Prisma — `repository.ts`'s
`PRICING_PROFILE_INCLUDE` was extended to also load `productColors` and
`decorationColorCharges`, and `toPricingProfileData` maps them into the same plain
data shape everything else already used.

## 11. API changes

- `POST /api/pricing`, `POST /apps/imprintid-pricing/pricing`: **additive only.**
  `CalculationInput` gained an optional `productColor?: { code }`; `PricingCalculationResult`
  gained `productColor` (null unless selected). No existing field changed shape or
  meaning. A real bug was caught and fixed during verification: the HTTP-boundary
  request parser (`app/lib/pricing-api/request.ts`) initially didn't parse
  `productColor` out of the raw JSON body at all, silently dropping it — found by the
  genuinely-signed verification script (§17 Case F), fixed, and covered by a regression
  test in `request.test.ts`.
- `GET /apps/imprintid-pricing/pricing?sku=...`: extended to return `productColors`,
  `decorationColorCharges`, and `priceCode`/`kind`/`code` fields wherever the schema now
  carries them (see §12). Still no calculation performed here — read-only projection.

## 12. Catalog response (additive)

```jsonc
{
  "sku": "LNY01",
  "quantityTiers": [{ "minQuantity": 100, "maxQuantity": 299, "priceCode": null, "listUnitPriceCents": 229, "netUnitPriceCents": 137 }],
  "productColors": [],              // empty for LNY01 — see §5
  "decorationMethods": ["SCREEN_PRINT"],
  "decorationColorCharges": [       // color 2 only, for LNY01 — see §8
    { "method": "SCREEN_PRINT", "colorNumber": 2, "chargeBasis": "ONE_TIME", "priceCode": null, "listPriceCents": 3500, "netPriceCents": 2800 },
    { "method": "SCREEN_PRINT", "colorNumber": 2, "chargeBasis": "PER_UNIT", "priceCode": null, "listPriceCents": 25, "netPriceCents": 20 }
  ],
  "optionGroups": [
    { "name": "Attachment — Standard", "kind": "ATTACHMENT", "isRequired": false, "categoryPriceAdjustmentCents": 0,
      "values": [{ "id": "...", "code": "SA03", "label": "J Hook", "priceCode": null, "priceAdjustmentCents": null }] }
  ],
  "productionRules": [ /* unchanged shape */ ]
}
```

Internal database ids are exposed only where the storefront genuinely needs one to
submit a selection (`OptionValue.id`, since that's the real selection key — see
`docs/pricing-engine.md`); everything else (colors, production, packaging) is
addressed by a stable public `code`.

## 13. Seed format

`PricingProfileImportInput` gained two optional array fields: `productColors` and
`decorationColorCharges` (both default to `[]` if omitted — fully backward compatible
with any import that predates this phase). `OptionGroupInput` gained an optional `kind`;
`QuantityTierInput`, `DecorationRuleInput`, `OptionValueInput` each gained an optional
`priceCode`. `importPricingProfile` persists all of these with the same
delete-then-recreate idempotent pattern every other collection already used — no new
import mechanism.

## 14. Migration

`20260827103210_pricing_model_expansion` — adds `priceCode` (nullable) to
`QuantityTier`, `DecorationRule`, `OptionValue`; adds `kind` (enum, default `GENERIC`)
to `OptionGroup`; creates `DecorationColorCharge` and `ProductColor`. No column was
renamed or dropped; no existing row was deleted. Verified: `prisma migrate deploy`
applied cleanly, `prisma migrate status` reports up to date (4 migrations total), and a
direct query immediately after migrating confirmed all pre-existing LNY01 rows (6
quantity tiers, 6 decoration rules, 6 option groups, 27 option values, 2 production
rules, 1 packaging rule) were untouched, with the new tables empty and the new `kind`
column defaulting to `GENERIC` as expected.

`prisma generate`'s file-rename step hit a persistent `EPERM` in this sandboxed Windows
environment (some other process held the query-engine binary open) — investigated, not
ignored: the newly generated binary was confirmed byte-identical (MD5) to the active
one, and the regenerated TypeScript types were confirmed present and load-bearing (the
whole rest of this phase's code compiles and runs against them). Documented as a
tooling quirk, not a real failure.

## 15. Validation

`validatePricingProfileImport` gained `validateProductColors` (non-empty code/name,
duplicate-code detection, optional-money check on `priceAdjustmentCents`) and
`validateDecorationColorCharges` (valid method/chargeBasis enum values, `colorNumber`
integer `>= 2`, duplicate `(method, colorNumber, chargeBasis)` detection, required
integer non-negative cents, net ≤ list). `validateOptionGroups` gained a `kind` enum
check. As before, every issue is collected — validation never stops at the first
problem.

## 16. Error handling

Two new, genuinely necessary error classes (matching the existing taxonomy's style —
one `readonly code` string, no raw Prisma leakage):

- `ProductColorNotFound` (`PRODUCT_COLOR_NOT_FOUND`) — the requested color code doesn't
  resolve among active colors (covers both "never configured" and "configured but
  inactive").
- `ColorPricingUnavailable` (`COLOR_PRICING_UNAVAILABLE`) — a requested color number has
  no configured `DecorationColorCharge`. Never silently treated as $0.

No existing error class was duplicated or removed.

## 17. Test coverage

**156 → 159** after the request-parsing bug fix (net **+33** over the Phase 2.6
baseline of 126, since some Phase 2.7 tests were added mid-phase before the fix). Full
breakdown:

- `calculator.test.ts`: +18 (per-color pricing 1/2/3/4 colors, missing/inactive color
  pricing, product color valid/no-adjustment/omitted/invalid/inactive, `priceCode`
  passthrough, `OptionGroup.kind`).
- `lny01.test.ts`: +2 (3-colors-is-an-honest-gap, no-product-colors-configured) plus the
  updated regression test (§18).
- `catalog.test.ts`: +4 (`kind` grouping, empty `productColors`, real color-2
  `decorationColorCharges`, `priceCode` is null throughout LNY01).
- `import.test.ts`: updated counts (`decorationRules` 6→4, + `decorationColorCharges`:
  2, + `productColors`: 0) and an idempotency check on the new
  `DecorationColorCharge` table.
- `request.test.ts`: +4 (the bug-fix regression test plus malformed/omitted
  `productColor` cases).
- `scripts/verify-app-proxy.mjs` (not part of `npm test`, run manually — see §16 in the
  final report): extended with Case F, a synthetic "SAGE-DEMO" product proving product
  color + 3-color decoration pricing through a genuinely HMAC-signed
  GET-catalog-then-POST-calculate chain — **this is what caught the request-parsing
  bug**, before it could have reached a real storefront.

## 18. Backward compatibility

The LNY01 worked example (quantity 1000, 2 colors, 2 locations, different reverse art,
repeat order, Cell Phone Loop option, rush production) **still produces exactly
233525¢ list / 153625¢ net** — asserted directly in `lny01.test.ts` and re-verified via
a live signed request in `scripts/verify-app-proxy.mjs` (Case B) against the real,
re-seeded database. The underlying representation changed (the old `ADDL_COLOR_SETUP`/
`ADDL_COLOR_RUN` `DecorationRule` rows were replaced by `DecorationColorCharge` rows for
`colorNumber=2` carrying the identical cent values — 3500/2800 setup, 25/20 run) — the
line-item *codes* in the response changed (`ADDL_COLOR_SETUP` → `COLOR_2_SETUP`,
`ADDL_COLOR_RUN` → `COLOR_2_RUN`), which is a visible, documented, and tested change,
but the *total* did not move by a single cent.

## 19. Assumptions

- Sage's per-category attachment surcharges (from Phase 2.2, e.g. "Heavy Duty +$0.23")
  are unrelated to this phase's `priceCode` concept and were not touched.
- `colorNumber` starting at 2 (not 1) assumes color 1 is always covered by a base
  setup rule — true for every decoration method LNY01 uses; not verified against any
  other method, since none is seeded.
- Packaging fee `chargeBasis` ambiguity noted in Phase 2.6 is unrelated to and
  unaffected by this phase.
- No assumption was made about Sage's actual pricing values — none were available to
  assume from (§2).

## 20. Limitations

- Product colors are fully implemented but not exercised by any real product yet — see
  §5. The Sage-style example in `verify-app-proxy.mjs` (Case F) is synthetic, clearly
  labeled as such, and cleaned up after the run.
- The Theme App Extension's new Product Color `<select>` was validated via Shopify
  CLI's Theme Check (`shopify app build`) and the same real-signed-request pipeline as
  the rest of the catalog/calculation flow, but — consistent with Phase 2.6's own
  documented limitation — no live browser/Theme Editor session was run in this
  sandboxed environment.
- `priceCode` has no index; none was added since nothing queries by it yet (documented
  as a deliberate "don't add unnecessary constraints" call, matching this project's
  established convention from Phase 2.2).

## 21. What's next

Not started, per the phase's stop condition: cart/checkout price mutation, Phase 3.
Recommended next step: source real product-color and multi-color decoration data for a
second real product (or for LNY01 itself, if ImprintID's actual price sheet has it) to
exercise these new dimensions with genuine data instead of only fixtures.
