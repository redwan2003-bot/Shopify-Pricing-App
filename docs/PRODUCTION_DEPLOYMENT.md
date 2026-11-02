# Production Deployment

ImprintID Dynamic Pricing runs on **Cloudflare Workers** with a **Neon PostgreSQL** database.
Shopify Functions (Cart Transform and Validation, both Rust) and the app configuration are
released through Shopify app versions. There is no container, Docker image or other host.

```
GitHub (main) --CI--> tests + Rust Function builds --> Shopify app version (extensions + config)
Operator ------------> pnpm run build && pnpm exec wrangler deploy --> Cloudflare Worker
Worker --------------> Neon PostgreSQL (pooled connection, one client per request)
```

Production Worker: `https://shopify-pricing-app.pdbd-primeit.workers.dev`
(`wrangler.jsonc`, name `shopify-pricing-app`). A separate preview Worker,
`shopify-pricing-app-preview`, is used to try changes before production.

---

## 1. CI/CD (`.github/workflows/ci-cd.yml`)

| Job | Runs on | What it does |
| --- | --- | --- |
| `rust-functions` (matrix: `imprintid-cart-pricing`, `imprintid-cart-validation`) | every push / PR | `cargo fmt --check`, `cargo test`, release wasm build, wasm must be under 256 KB |
| `validate-and-test` | every push / PR | `pnpm install --frozen-lockfile`, Prisma client, validation parity corpus check, `pnpm test` against the Neon **test** branch, `pnpm run build` |
| `deploy-shopify-app` | push to `main` / manual only, after both jobs above | `shopify app deploy` of the extensions and `shopify.app.production.toml` |

CI does **not** deploy the Worker. A push to `main` creates and releases a Shopify app version
automatically, so treat a merge to `main` as a release of the Functions and app configuration.

### GitHub Actions secrets

| Secret | Purpose |
| --- | --- |
| `TEST_DATABASE_URL` (and optionally `TEST_DATABASE_URL_UNPOOLED`) | Neon **test** branch. The job refuses to run if it names the production endpoint. |
| `IMPRINTID_CART_SIGNING_SECRET` | Baked into both Functions at build time. Must equal the Worker's value. |
| `SHOPIFY_APP_AUTOMATION_TOKEN` | Lets the Shopify CLI deploy from CI. |

---

## 2. Worker secrets

Set with `pnpm exec wrangler secret put <NAME>` (or `wrangler secret bulk`). Values are never
stored in git; `.env.production.example` lists names with placeholders only.

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`,
`SHOPIFY_APP_URL`, `IMPRINTID_CART_SIGNING_SECRET`, plus the R2 variables if artwork upload is
used. `IMPRINTID_ADJUSTMENT_VARIANT_ID` is optional (single-store pinning only).

Deploy the Worker (preview first, then production):

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm exec wrangler deploy --name shopify-pricing-app-preview
pnpm exec wrangler deploy --name shopify-pricing-app
```

---

## 3. Database (Neon)

* Production and test are separate Neon branches/endpoints. Tests and CI use the test branch only.
* The schema lives in `prisma/schema.prisma`; migrations are in `prisma/migrations` (baseline
  `20261026_neon_baseline`). Apply with `pnpm exec prisma migrate deploy` using the **unpooled**
  connection string. Review the SQL of any new migration before applying it to production.
* `prisma/migrations_postgresql` and `prisma/migrations_sqlite_legacy` are kept as history only.
* Rotating a Neon role password changes the connection strings: update the Worker secrets and the
  GitHub secrets together, then confirm the production Worker can still read the database.

---

## 4. Signing secret

`IMPRINTID_CART_SIGNING_SECRET` signs the price quotes the app proxy issues and is verified inside
both Functions. Shopify Functions cannot read environment variables, so the value is **baked into
the wasm at build time** (`pnpm run fn:config` writes the gitignored
`src/config.secret.generated.{ts,rs}`). The Worker, both Functions and the CI secret must hold the
same value. Changing it means: rebuild and release a new Shopify app version, update the Worker
secret, and update the GitHub secret. Compare values by fingerprint only (`fn:config` prints
`sha256:` plus the first 8 hex characters); never print the secret.

Generate a new value with a CSPRNG, for example `openssl rand -hex 32`. Never reuse a value that has
appeared in git history, a chat, or a ticket.

---

## 5. Releasing Functions and app configuration

Create a version without releasing it, inspect it, then release it deliberately:

```bash
pnpm run fn:config
shopify app deploy --config production --no-release --message "<what changed>"
shopify app versions list --config production --json
shopify app release --config production --version=<version-tag> --allow-updates
```

Rollback is releasing the previous version tag with the same release command.

Enforcement is controlled per shop by the `$app:imprintid/enforcement_policy` metafield (modes
`disabled`, `pilot`, `universal`, `maintenance`). In `pilot`, only products whose
`$app:imprintid/pricing_policy` has `required: true` and `active: true` are enforced; products with
`active: false` are blocked at checkout. Change the mode deliberately and one step at a time.

---

## 6. Seeding catalog data (pricing profiles and product links)

The storefront prices a product only when **three things agree**: the pricing profile exists in
the production database, a `ProductPricingOverride` row links the Shopify product to it, and the
product's `$app:imprintid/pricing_policy` metafield carries that profile's id and revision.
Profile ids are generated per database and the revision bumps when a re-import changes pricing, so
re-importing leaves the metafields stale until they are re-synced. Until all three match, quotes
fail validation.

Run these from a trusted machine with `DATABASE_URL` pointing at the target database (use the
direct connection string; never paste it into chat or a ticket):

```bash
pnpm exec prisma generate

# 1. Load the pricing profiles (idempotent; safe to re-run)
pnpm run catalog:import -- "path/to/imprintid_catalog_shopify_import_updated.csv" --shop imprintid-pricing-dev.myshopify.com

# 2. Open the ImprintID app once in Shopify admin so its Admin session is fresh, then compare the
#    store and the database (read-only, exits 1 if anything differs)
pnpm run catalog:link -- --check

# 3. Link products and write/refresh the policy metafields (skips ones already correct)
pnpm run catalog:link

# 4. Confirm
pnpm run catalog:link -- --check     # should print "In sync."
```

Repeat steps 2-4 after any pricing re-import. For bulk policy changes prefer the guarded
plan/apply/rollback scripts (`scripts/stamp-readiness.mjs`, `scripts/pilot-scope.mjs`): they write
a manifest before changing anything and can roll back.

---

## 7. Shopify app proxy and URLs

`shopify.app.production.toml` must use the Worker origin:

```toml
application_url = "https://shopify-pricing-app.pdbd-primeit.workers.dev"

[auth]
redirect_urls = [
  "https://shopify-pricing-app.pdbd-primeit.workers.dev/auth/callback",
  "https://shopify-pricing-app.pdbd-primeit.workers.dev/auth/shopify/callback",
]

[app_proxy]
url = "https://shopify-pricing-app.pdbd-primeit.workers.dev/apps/imprintid-pricing"
subpath = "imprintid-pricing"
prefix = "apps"
```

Push configuration changes through a Shopify app version (section 5), not by editing the Partner
Dashboard by hand.
