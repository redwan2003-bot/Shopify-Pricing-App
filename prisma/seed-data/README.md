# Seed data notes — LNY01

Source-data interpretation decisions made while transcribing the ImprintID pricing
sheet into `lny01.ts`, so they're recorded once instead of only living in code comments.

- **Standard vs. premium attachments.** The source gives one surcharge per premium
  category (Heavy Duty +$0.23, Dual +$0.20, Plastic +$0.20, Black Metal +$0.20), not per
  individual attachment. That price is stored on `OptionGroup.categoryPriceAdjustmentCents`
  for a group scoped to that category; individual `OptionValue.priceAdjustmentCents` is
  left `null` ("not supplied") rather than copied from the category. "Standard attachment
  is included" is treated as a confirmed category price of `0`, since the source states
  it directly — this is different from a missing price.
- **Duplicate vendor codes.** The source reuses the same code for multiple distinct items
  (e.g. `SA04` for both "Keyring" and "Non-swivel Bulldog"; `BK09` for all four Black
  Metal items). This is preserved as given — `OptionValue.code` is not unique, only
  `(optionGroupId, label)` is, matching how the schema already worked.
- **The trailing "V" on Optional Features prices** (e.g. "Price: +$0.30 V") is not
  interpreted — its meaning wasn't given, so only the numeric price was stored.
- **No rush surcharge amount was supplied**, so `ProductionRule.feeCents` is `null` for
  the RUSH rule (not `0`). Same for the standard-carton `PackagingRule.feeCents`.
- **No known Shopify product ID for LNY01 yet.** No `ProductPricingOverride` row is
  created by the seed. `PricingProfile.sku = "LNY01"` is the lookup key until the product
  is linked — see the main pricing docs for the linking plan.
