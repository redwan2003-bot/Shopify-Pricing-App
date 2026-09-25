# Shopify Production Architecture Audit

Read-only audit performed 2026-09-25 against commit `aedc17e`. Scope: everything checkable from
source, config, and local test runs — nothing here required a live Shopify session or production
credentials (see `PRODUCTION_DATABASE_READINESS.md` for the checks that do).

Legend: **PASS** / **FAIL** / **WARNING** / **MANUAL ACTION REQUIRED**

## 1. Secrets and credential hygiene

| # | Item | Result |
|---|---|---|
| 1.1 | No live `.env` committed | PASS — only `.env.example` / `.env.production.example` are tracked; `.env`, `.env.*` (except `.example`), `*.sqlite`, and `prisma/dev.sqlite` are all gitignored. |
| 1.2 | `config.secret.generated.ts` (the two Function-baked signing-secret files) not committed | PASS — only the `.example.ts` variants are tracked (`git ls-files` confirms); the real generated files exist only on disk. |
| 1.3 | Example/template files contain only placeholders | **FAIL (now fixed in this commit) — was CRITICAL.** `.env.production.example` contained the **real** `IMPRINTID_CART_SIGNING_SECRET` value in cleartext, not a placeholder. It matched the value baked into both `extensions/*/src/config.secret.generated.ts` exactly. This was added in commits `5edcdd7` and `a4a0217`, both already present on `origin/main` (confirmed via `git show origin/main:.env.production.example`). Fixed in this session by replacing the value with a placeholder and a comment warning never to reuse a value that appeared in this file's history. |
| 1.4 | **MANUAL ACTION REQUIRED** — rotate the leaked secret | Editing the file does not undo the exposure: the real value is still in git history and already pushed. Before public launch, generate a fresh `IMPRINTID_CART_SIGNING_SECRET`, update Render's environment variable, regenerate both `config.secret.generated.ts` files (`npm run fn:config`), and redeploy the two Shopify Functions so they're signing/verifying with the new secret. Old signed quotes become invalid the moment this rotates (acceptable — quotes are short-lived). Confirm whether the GitHub repo is private (an unauthenticated API check returned 404, consistent with private, but confirm directly in GitHub settings) — private reduces but does not eliminate the exposure. |
| 1.5 | Repo visibility check itself | MANUAL ACTION REQUIRED — could not be confirmed from this environment; the user should verify in GitHub repo settings. |

## 2. API surface

| # | Item | Result |
|---|---|---|
| 2.1 | Admin API usage is GraphQL only, no legacy REST | PASS — `grep -rn "admin\.rest\|\.rest\."` across `app/` returns nothing; all Shopify calls in `app/lib/` use `admin.graphql(...)`. |
| 2.2 | API version is current and pinned | PASS — `ApiVersion.July26` set once in `app/shopify.server.ts`, re-exported, used consistently. Webhook `api_version` in both `.toml` files also `2026-07`, matching. |
| 2.3 | Access scopes are minimal | PASS — `write_products,write_cart_transforms,write_validations` only, with an inline comment in `shopify.app.toml` explaining why each is needed and why `read_*`/metaobject scopes were deliberately dropped. |

## 3. Embedded app architecture

| # | Item | Result |
|---|---|---|
| 3.1 | `embedded = true` in both app config tomls | PASS |
| 3.2 | App Bridge script loads correctly | PASS — `<AppProvider embedded apiKey={apiKey}>` in `app/routes/app.tsx` (apiKey sourced from the loader, not hardcoded); `@shopify/shopify-app-react-router`'s `AppProvider` auto-renders `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key=...>` — confirmed by reading the installed package source. No separate/stale script tag exists elsewhere. |
| 3.3 | Session-token auth (no third-party-cookie dependency) | PASS — `authenticate.admin(request)` (JWT session-token pattern) is used on every embedded loader/action; verified directly in this session's live tests by signing HS256 session tokens and calling loaders with no cookies at all. |
| 3.4 | App Bridge / dependency versions current | INFORMATIONAL — `@shopify/app-bridge-react ^4.2.4`, `@shopify/shopify-app-react-router ^1.2.1`, `react-router ^7.12.0`. This audit cannot check these against the latest npm releases (no network access); run `npm outdated` before submission as a manual step. |

## 4. Webhooks

| # | Item | Result |
|---|---|---|
| 4.1 | Mandatory privacy webhooks registered and handled | PASS — `customers/data_request`, `customers/redact`, `shop/redact` declared via `compliance_topics` in `shopify.app.production.toml`, handled in `app/routes/webhooks.compliance.tsx` (verified live with valid/wrong/tampered HMACs on 2026-09-24 per project memory). |
| 4.2 | `app/uninstalled` handled, cleans up sessions | PASS — `app/routes/webhooks.app.uninstalled.tsx` deletes all session rows for the shop, idempotently (tolerates a webhook firing after the session is already gone). |
| 4.3 | `app/scopes_update` handled | PASS — updates the stored session's `scope` field. |
| 4.4 | HMAC verification | PASS — every webhook route calls `authenticate.webhook(request)`, which verifies HMAC internally (library-enforced, not reimplemented). |
| 4.5 | Product webhooks are shop-scoped and dedupe | PASS — `products/{create,update,delete}` handlers require a resolved `session` before processing and pass `webhookId` through to `handleProductWebhookEvent` for dedup (per its existing test coverage). |

## 5. URLs and environment

| # | Item | Result |
|---|---|---|
| 5.1 | Production URLs are HTTPS | PASS — `application_url`, `auth.redirect_urls`, `app_proxy.url` in `shopify.app.production.toml` are all `https://shopify-pricing-app.onrender.com/...`. |
| 5.2 | No localhost/dev URLs in production config | PASS — `grep -n localhost shopify.app.production.toml app/shopify.server.ts` returns nothing. |
| 5.3 | Environment variables documented | PASS (after this session's fix) — `.env.example` and `.env.production.example` both list every variable the app reads, with comments; the latter's stale example URL (`pricing.imprintid.com`, not the real Render URL) and leaked secret were corrected in this session. |
| 5.4 | `distribution` matches intent | WARNING — `app/shopify.server.ts` sets `distribution: AppDistribution.AppStore` in code, consistent with the public-listing goal, but the Partner Dashboard's own Distribution setting for app `ff2a27051df6abf548cc227e021e97a4` has **not** been confirmed by the user yet (carried over from before this session — see project memory). This is a manual, dashboard-side check only the user can complete. |

## 6. Billing

| # | Item | Result |
|---|---|---|
| 6.1 | Billing implemented | **FAIL (expected at this stage)** — no Billing API code, no `[pos]`/pricing block in either `.toml`, no subscription-status handling anywhere in `app/`. This is a hard blocker for public App Store submission and is scoped separately in `BILLING_ARCHITECTURE.md`. |

## 7. Data model / multi-tenancy

| # | Item | Result |
|---|---|---|
| 7.1 | Cross-shop data isolation | PASS — every Prisma query in the pricing-editor and import paths scopes by `storeId`/`shopDomain`; live-verified in this session (`scripts/_editor-live.mjs`): another shop's pricing profile 404s on load and is refused on save ("no longer exists"). |
| 7.2 | App-owned metafields, not metaobjects | PASS (design choice, documented) — `$app:imprintid/*` metafields only; the scope comment in `shopify.app.toml` explains `write_metaobjects` was deliberately dropped. |

## Summary

No **new** code-correctness failures. One **critical, now-fixed** hygiene issue (§1.3/1.4 — a
real secret was committed as an "example" value and needs rotation, not just the file fix). One
outstanding **manual, dashboard-only** action (§5.4, confirm Distribution = Public). Billing is
the only large missing piece, tracked separately and expected at this stage of the plan.
