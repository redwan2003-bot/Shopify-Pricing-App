# Production Release Readiness

Status: **operational baseline verified 2026-11-04**.

The current release target is an owner-operated, non-billed Shopify app on Cloudflare Workers and
Neon. It is not a paid public App Store launch. Use `docs/PRODUCTION_OPERATIONS.md` as the release
and incident runbook; the September Render/App Store audits are historical evidence only.

## Verified production baseline

| Check | Result |
| --- | --- |
| Source | `origin/main` = `8e9dacdebae0db612f792065b626f0af8d27b1c7` |
| Worker | HTTP 200 health; version `1a8c42e2-7627-40a6-bcd3-6e9ecbeccac1` |
| Shopify app version | `imprintid-dynamic-pricing-50`, active, built from the same commit |
| Signing-secret fingerprint | `d23c73d4`, enforced by the deployment workflow |
| Production catalog | 13,387 products; 147 profiles; 145 linked/enforcement-ready |
| Enforcement | `pilot` |
| Billing | Not applicable; retired code and gates removed |
| Hosting | Cloudflare Workers + Neon; Render retired |

The merchant journey was verified through Home, Product Configuration, Pricing Profiles,
Attachments, and Import Pricing. The production Worker served authenticated requests successfully.

## Local release-candidate quality gate (2026-11-04)

The current uncommitted candidate passed:

- Full application suite: 1,044 tests discovered; 1,043 passed, 0 failed, and one intentionally
  skipped full-port performance round trip.
- Pricing-editor live flow against the isolated Neon test branch: all checks passed.
- PostgreSQL case-insensitive SKU-search regression: 2/2 passed.
- Rust Functions: 8/8 Cart Transform tests and 16/16 Validation tests passed; release wasm sizes
  were 133,457 bytes and 209,718 bytes, both below Shopify's 256 KB limit.
- Typecheck, lint, production build, GraphQL code generation, frozen-lockfile install, and Shopify
  production-config validation passed.
- Production dependency audit reported no known vulnerabilities. Remaining audit notices are in
  build-only upstream tooling and are not shipped in the Worker or Rust Functions.
- Credential-pattern scan found no tracked private keys or common live-token formats; generated
  Function secret files remain ignored.

## Intentional limits

- Two archived-only products are intentionally unlinked; they are not launch blockers.
- Order Workflows is intentionally disabled and hidden while `ENABLE_ORDER_WORKFLOWS` is unset.
- Technical `AppDistribution.AppStore` remains unchanged for Shopify Functions compatibility. It
  does not imply paid billing or an active listing effort.
- Enforcement remains in `pilot`; expanding to `universal` is a separate controlled rollout.

## Gate for the next release

A release is ready only when:

1. The pull request's latest commit has green Test & Build and both Rust Function jobs.
2. Any migration SQL has been reviewed and a recovery point is available.
3. Worker and Shopify changes are released in the order in the operations runbook.
4. Worker health, active Shopify version, signing fingerprint, merchant pages, quote/cart behavior,
   and catalog synchronization all pass after release.
5. The previous Worker deployment and Shopify app version remain available for rollback.

Do not use the old Render, SQLite, paid billing, or 123-held-back-SKU claims as current launch
criteria.
