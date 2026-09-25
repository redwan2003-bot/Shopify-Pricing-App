# Billing Architecture — ImprintID Dynamic Pricing

Status: **draft — blocked on business decisions**, not yet implemented. Nothing in this file is
built; this is the design to review before implementation starts.

## Current state

No billing code exists anywhere in `app/`. No `[app_pricing]`/pricing block exists in either
`.toml`. This is expected at this stage — it's the next thing to build, not a bug in what's
already shipped.

## Recommended approach: Shopify App Pricing (Managed Pricing), not a custom Billing API integration

For a new public app, Shopify's current guidance is to use Shopify App Pricing rather than
building custom `AppSubscriptionCreate`/webhook logic by hand, unless the pricing model needs
something Shopify App Pricing genuinely can't express. Shopify hosts the plan-selection UI,
handles recurring charges, trials, and plan changes, and merchants can change plans without
contacting support — which Shopify explicitly requires apps to support. This app's pricing model
(a flat subscription gating access to the dynamic-pricing feature set) fits Shopify App Pricing
well; there's no usage-based or per-transaction billing need identified so far.

**This audit could not verify the exact current TOML/CLI configuration surface for Shopify App
Pricing from this environment (no network access to shopify.dev).** Configuration is primarily
done through the Partner Dashboard's Pricing tab for the app record; confirm the current
mechanism (dashboard-only vs. also configurable via `shopify.app.toml`) directly in the Partner
Dashboard or with `shopify app config push --help` before implementing.

## What still needs implementation regardless of dashboard vs. TOML configuration

Even with Shopify hosting the plan-selection UI, the app itself must:

1. **Check subscription status on every relevant request.** Add an entitlement check (likely a
   helper alongside `authenticate.admin`) that reads the shop's active subscription and gates
   pricing-profile creation/editing and the storefront cart-pricing signing path accordingly.
2. **Handle every subscription state**, not just "active":
   - No subscription (fresh install, before plan selection)
   - Active
   - Expired / declined
   - Cancelled
   - Pending approval (merchant approved on Shopify's side but the app hasn't confirmed yet —
     a real race condition; don't assume synchronous confirmation)
   - Reinstall (a shop that previously had a subscription installs again)
   - Upgrade / downgrade between plans, if more than one plan is offered
3. **Fail safe, not open.** If the app cannot determine subscription status (API error, timeout),
   default to treating pricing as **unavailable**, not available — consistent with this app's
   existing "fails closed" pattern for cart signing (`IMPRINTID_CART_ENVELOPE_VERSION` unset ⇒
   `cartPricing: null`, never a silent default).
4. **Decide what "gated" means for this app specifically.** Candidates, not yet decided:
   - Block creating/editing pricing profiles without an active subscription (safest — keeps a
     lapsed subscriber's storefront prices frozen rather than broken).
   - Block the storefront cart-pricing signing path itself (harsher — an expired subscription
     would make the merchant's live storefront stop quoting prices for enrolled products, which
     is riskier for a merchant's business and worth the user's explicit sign-off before building).
5. **Test every state above** — this needs its own test file alongside the eventual
   `app/lib/billing/` module, following the same live-verification pattern used for settings and
   the pricing editor (a stubbed Admin API for `AppSubscriptionCreate` / `currentAppInstallation`
   responses, driven by signed session tokens).

## Open questions — need the user's decision before implementation

These are business decisions, not technical ones, so nothing here is guessed:

- Plan name and monthly price.
- Whether to offer a free trial, and its length.
- Whether to offer more than one paid tier at launch (the recommendation above is to start with
  exactly one plan — simplicity reduces both build and review surface — and add tiers later if
  there's a real reason to).
- Which of the two gating options in item 4 above (block editing vs. block storefront pricing) on
  a lapsed/cancelled subscription.

## Suggested sequencing once decided

1. Configure the plan(s) (Partner Dashboard and/or TOML, per the confirmed current mechanism).
2. Build `app/lib/billing/` — a `readSubscriptionStatus` helper mirroring
   `app/lib/catalog/admin-client.ts`'s `readShopPolicyContext` pattern (typed ok/error result,
   never throws to the caller), plus the entitlement gate chosen above.
3. Wire the gate into the pricing-profile editor's `editAction` and/or the storefront signing
   path per the decision in item 4.
4. Write the state-matrix test suite.
5. Live-verify against a stubbed Admin API the same way `scripts/_editor-live.mjs` did for the
   editor.
6. Update `RELEASE_READINESS.md`'s known-issues list once this lands.
