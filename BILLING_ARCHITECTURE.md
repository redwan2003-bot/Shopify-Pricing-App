# Billing Architecture — ImprintID Dynamic Pricing

Status: **implemented** (2026-09-25). This is now a record of what was built and why, not a
proposal — kept for anyone reviewing the launch readiness work later.

## Decisions (made by the user, 2026-09-25)

- One flat plan: **$29.99/month, 14-day free trial**. No tiers at launch.
- Gating scope: a lapsed/cancelled/expired subscription blocks **editing/creating pricing
  profiles only**. Already-linked products keep quoting their last saved prices on the
  storefront regardless of subscription status — nothing changes for shoppers when a merchant's
  subscription lapses.

## What was built

Uses the officially supported billing module built into
`@shopify/shopify-app-react-router` (`authenticate.admin(request)` returns a `billing` context
with `check`/`request`/`cancel`/`require`) rather than hand-rolling GraphQL calls — this is the
first-party mechanism for this exact app template, not a workaround.

- **`app/shopify.server.ts`**: `billing: { [MONTHLY_PLAN]: { trialDays: 14, lineItems: [{ amount:
  29.99, currencyCode: "USD", interval: BillingInterval.Every30Days }] } }`. `MONTHLY_PLAN` itself
  lives in `app/lib/billing/plan.ts` — a separate, side-effect-free module — so it can be imported
  by unit tests without pulling in `shopifyApp()`, which throws at import time without
  `SHOPIFY_APP_URL`/`SHOPIFY_API_KEY` set.
- **`app/lib/billing/entitlement.ts`**: `readEntitlement(billing.check)` — never throws; a
  transport failure or any exception comes back as `{ ok: false, hasActivePayment: false }`, so
  callers fail closed exactly like `readShopPolicyContext` does for the enforcement policy.
  `isTestBillingMode()` defaults to "not production" and can be forced either way with
  `SHOPIFY_BILLING_TEST_MODE`.
- **`app/lib/billing/billing-route.server.ts`** + **`app/routes/app.billing.tsx`**: the Billing
  page. Shows current status; "Subscribe" posts `intent=subscribe`, which calls `billing.request`
  (this throws internally — Shopify's library redirects the merchant to its own confirmation
  page, either via a 302 or, for an embedded session-token request, a 401 carrying
  `X-Shopify-API-Request-Failure-Reauthorize-Url` for App Bridge to follow). "Cancel subscription"
  posts `intent=cancel`, calling `billing.cancel`.
- **The gate**: `app/lib/pricing-editor/editor-route.server.ts`'s `editLoader` now returns
  `canEdit` (used to show a banner and disable the Save button in
  `app/routes/app.pricing-profiles.$id.tsx`), and `editAction` refuses to save with a friendly
  message when `!hasActivePayment` — checked before any parsing or writes happen. Viewing/listing
  profiles is **not** gated, matching the "block editing only" decision.
- Nav link added ("Billing") in `app/routes/app.tsx`.

## Test coverage

- `app/lib/billing/entitlement.test.ts` (6 tests, `node --test`): `isTestBillingMode`'s
  default/override behavior; an active subscription is reported correctly; no subscription is a
  clean non-error result; `hasActivePayment: true` with an empty subscriptions array (a shape
  Shopify's API could in principle return) is still treated as **not** entitled rather than
  crashing; a thrown `Error` and a thrown non-`Error` value both fail closed with a usable
  message.
- `scripts/_billing-live.mjs` (12 checks against a stubbed Admin API, real signed session
  tokens): no-subscription state; `billing.request`'s 401/reauth-header redirect carries
  Shopify's real confirmation URL; the subscribe request uses the configured plan name, $29.99,
  and 14-day trial; the loader reflects an approved subscription's details; cancel works and its
  message states the storefront/existing-profile impact; cancelling with no subscription id and
  an unrecognized action intent are both refused cleanly instead of silently ignored.
- `scripts/_editor-live.mjs` extended with 6 billing-gate checks: `canEdit` is `false` on both
  the new-profile and edit pages without a subscription; a save attempt is refused with nothing
  written and the profile's revision untouched; `canEdit` returns to `true` once the subscription
  is active again. The script's other 21 profile-CRUD checks now run against a stubbed **active**
  subscription by default, so the billing gate doesn't change their outcome.

Full suite: 961/961 passing (was 955 before this work — 6 new entitlement unit tests). Typecheck
and lint clean.

## What's still manual / not covered by this pass

- **The actual $29.99 monthly recurring charge has never been exercised against a real Shopify
  store.** Everything above is verified against a stubbed Admin API. Before submission, install
  on a real dev/Basic/Grow store with `SHOPIFY_BILLING_TEST_MODE` unset (or `true`) and walk the
  real subscribe → approve → cancel flow once, watching Shopify's actual confirmation page.
- `billing.check`'s pagination over `oneTimePurchases` was not exercised (this app has no
  one-time-purchase plan, so `oneTimePurchases` is always empty in practice) — not a gap for this
  app's model, noted for completeness.
- No UI test coverage for the Billing page's rendering itself (banners, button states) — only its
  server-side loader/action logic. Consistent with how the rest of this app's admin UI is tested
  (server logic live-verified; the JSX itself is reviewed, not automated).
- The Home page does not yet surface subscription status (only the dedicated Billing page and the
  in-editor banner do). Not required by the decisions above; can be added later if useful.
