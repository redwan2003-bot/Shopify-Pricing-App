# Release Readiness — ImprintID Dynamic Pricing

Baseline frozen at commit `aedc17e` (tagged locally `release-baseline-2026-09-25`, **not pushed**).
This document is the Phase 0 snapshot for the App Store launch effort. It is a status report,
not a go/no-go gate — see `SHOPIFY_PRODUCTION_AUDIT.md` and `PRODUCTION_DATABASE_READINESS.md`
for the audits, and `RELEASE_CANDIDATE_REPORT.md` (written later, before the final push) for the
actual gate.

## Baseline metrics (verified 2026-09-25)

| Check | Result |
|---|---|
| Unit/integration tests | **955 / 955 passing** (`npm test`) |
| Typecheck | **clean** (`npm run typecheck`) |
| Lint | **clean** (`npx eslint app/`) |
| SQLite ↔ PostgreSQL schema drift | **none** beyond the `datasource` block (CI-enforced) |
| Live pricing-editor checks | **21 / 21 passing** (`scripts/_editor-live.mjs`, stubbed Admin API + real SQLite) |
| Live storefront checks (from 2026-09-23) | 19 interaction + 4 security + cold start + inquiry + options + cart, all passing |
| Live settings checks (from 2026-09-23) | 9 checks passing |
| Live CSV import checks (from 2026-09-23) | real 3.4 MB catalog file: 270 products / 147 ready / 123 held back, idempotent re-run |

No code changes were made to reach this baseline beyond what was already committed as of
`aedc17e` (the pricing-profile editor). Freeze is in effect: the plan below explicitly avoids
touching the pricing-profile CRUD path unless a release blocker is found there.

## Known issues at baseline

1. **123 catalog SKUs held back on import**, categorized in `PRODUCTION_DATABASE_READINESS.md`
   §"CSV held-back reasons" — none are import bugs; each needs source-data attention (missing
   quantity tiers, a fuzzy/derived SKU match, or a decoration-method mapping) and can now be
   fixed one at a time in the new pricing-profile editor.
2. **Product-linking state cannot currently be verified against production.** The local dev
   Prisma database's offline session for `imprintid-pricing-dev.myshopify.com` expired
   2026-09-22; the most recent CSV re-import (2026-09-23) ran *after* that, so its automatic
   relink step could not authenticate and only logged an error — it did not block the import.
   Locally only 1 of 147 profiles shows as linked, and that single row uses a legacy bare-numeric
   `shopifyProductId` format inconsistent with the current gid-based linking code. This does
   **not** mean production is in this state — Render's Postgres is a separate database this
   environment has no access to — but it does mean the earlier "145 linked / 2 held back" figure
   from 2026-09-23 is unverified against current code and must be re-confirmed with a live
   session before launch. See `PRODUCTION_DATABASE_READINESS.md`.
3. **A real production secret was committed to git as an "example" value.**
   `.env.production.example` contained the actual `IMPRINTID_CART_SIGNING_SECRET` in cleartext
   (added in commits `5edcdd7` / `a4a0217`, already on `origin/main`). Fixed in this session by
   replacing it with a placeholder (see `SHOPIFY_PRODUCTION_AUDIT.md` §1 for the full writeup) —
   **the underlying secret itself still needs rotation**, since git history retains the old
   value regardless of this fix.
4. **Render Postgres seed/link status is unverified** from this local environment (no
   credentials here) — carried over from before this session.
5. **Billing is not implemented.** No Billing API or Shopify App Pricing configuration exists in
   the codebase. This blocks App Store submission for a public app and needs a business decision
   (plan name, price, trial) before implementation — tracked in `BILLING_ARCHITECTURE.md`.
6. Listing assets (icon, screenshots, screencast, test instructions), privacy policy URL, and
   support contact are not yet prepared.
7. No test has been run on a real Basic/Grow-plan store — only the Partner dev store.

## What's explicitly out of scope for this pass

Per the user's original editor scope: bulk editing and new decoration methods. Per this launch
plan: no feature development on the pricing-profile editor itself unless a release blocker
surfaces there — it is frozen at `aedc17e`.
