# Production Operations Runbook

Last verified: **2026-11-04**

This is the authoritative operating runbook for ImprintID Dynamic Pricing. The app is an
**owner-operated, non-billed production app** for ImprintID. It is not being prepared as a paid
public App Store listing. There are no subscription plans, billing routes, or billing gates.

`AppDistribution.AppStore` remains in `app/shopify.server.ts` deliberately because Shopify
Functions availability depends on the app's technical distribution and store plan. That setting
does not make this a paid listing and must not be changed without a separate Shopify Functions
compatibility review.

## Production inventory

| Component | Production value |
| --- | --- |
| Source of truth | `main` in GitHub |
| Web application | Cloudflare Worker `shopify-pricing-app` |
| Worker URL | `https://shopify-pricing-app.pdbd-primeit.workers.dev` |
| Database | Neon PostgreSQL production branch |
| Shopify app | ImprintID Dynamic Pricing |
| Shopify store | `imprintid-pricing-dev.myshopify.com` |
| Shopify release | App configuration, theme extension, Cart Transform, Validation Function |
| Current signing fingerprint | `d23c73d4` (verified 2026-11-04; changes on the next rotation) |

Production and test use separate Neon endpoints. CI must never point at the production endpoint.
Secrets live in Cloudflare and GitHub Actions, never in tracked files.

## Release ownership and order

Merging to `main` is a production action. GitHub Actions first runs Test & Build and both Rust
Function jobs. Only when all three succeed does `deploy-shopify-app` build and release a Shopify
app version. CI does **not** deploy the Worker.

For a change that touches both the Worker and Shopify Functions:

1. Confirm the pull request's latest commit has three green jobs: Test & Build and both Rust
   Function jobs.
2. If a database migration is included, review its SQL and apply it with the unpooled production
   connection before code that depends on it. Prefer additive, backward-compatible migrations.
3. Deploy and verify the Worker while the existing Shopify version is still compatible:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   pnpm exec wrangler deploy --name shopify-pricing-app
   ```

4. Merge the reviewed commit to `main`. Watch `deploy-shopify-app` through completion.
5. Complete every post-release check below. Do not remove the previous Shopify version or Worker
   deployment; they are the rollback targets.

For a Functions/config-only change, skip the Worker deployment. For a Worker-only change, do not
merge unrelated Shopify configuration merely to deploy the Worker.

## Post-release verification

Run these checks after every production release:

```bash
git fetch origin main
git rev-parse origin/main
pnpm exec wrangler deployments status --name shopify-pricing-app
shopify app versions list --config production --json
pnpm run catalog:link -- --check
```

Also verify:

- `GET https://shopify-pricing-app.pdbd-primeit.workers.dev/health` returns HTTP 200 with
  `{"status":"ok","service":"shopify-pricing-app"}`.
- The active Shopify version message names the expected `main` commit.
- GitHub's `deploy-shopify-app` job passed its signing-secret fingerprint check.
- Home, Product Configuration, Pricing Profiles, Attachments, and Import Pricing load in Shopify
  admin.
- A known pilot product can quote and add to cart, and an invalid/tampered quote is rejected.
- `catalog:link -- --check` ends with `In sync.`; treat any mismatch as release-blocking drift.

The app's Order Workflows page is intentionally hidden while `ENABLE_ORDER_WORKFLOWS` is unset.
Do not enable it as part of an unrelated release.

## Rollback

### Shopify Functions and app configuration

List versions, select the last known-good inactive version, then release it:

```bash
shopify app versions list --config production --json
shopify app release --config production --version=<previous-version-tag> --allow-updates
```

Re-run the post-release checks. A rollback version must use a signing secret compatible with the
currently deployed Worker. If it does not, roll back the Worker to the matching deployment or
complete a coordinated signing-secret rotation.

### Cloudflare Worker

List deployments, identify the last known-good version ID, then roll back with an audit message:

```bash
pnpm exec wrangler deployments list --name shopify-pricing-app
pnpm exec wrangler rollback <version-id> --name shopify-pricing-app --message "Rollback: <reason>"
```

Worker rollback changes code immediately but does not restore external data or deleted/changed
bindings. Confirm the target version is compatible with the current Neon schema and Cloudflare
resources before running it.

Verify `/health`, authenticated admin pages, quoting, and catalog synchronization afterward.

### Database

Production migrations are forward-only by default. Do not reverse a migration or restore a Neon
branch while writes continue. For a data incident:

1. Put enforcement in `maintenance` if checkout safety is uncertain.
2. Stop the release and preserve logs, the migration SQL, and the affected time window.
3. Create or select a Neon restore branch at a point before the incident and validate it without
   changing the Worker connection.
4. Choose a forward repair whenever possible. Switching production to restored data requires
   owner approval, a write freeze, connection-secret updates, and a full post-release check.

## Signing-secret rotation

The Worker and both Shopify Functions must share one `IMPRINTID_CART_SIGNING_SECRET`. Never print
or compare the value itself; compare only its SHA-256 fingerprint prefix.

1. Generate a new cryptographically random value.
2. Update the GitHub Actions secret.
3. Update the Cloudflare Worker secret.
4. Build and release both Functions from the same value through the reviewed `main` workflow.
5. Confirm the deployment job reports the expected fingerprint and the active Shopify version is
   from the expected commit.
6. Test a fresh quote and cart operation. Old short-lived signed quotes may stop working.

When rotating, update the expected fingerprint in
`.github/workflows/ci-cd.yml` in the same reviewed change. The value `d23c73d4` is only the current
verified fingerprint, not a permanent constant.

## Incident modes

| Symptom | Immediate action |
| --- | --- |
| Worker unavailable or authentication failing | Roll back the Worker; verify Neon and Shopify secrets before redeploying. |
| Worker/Function signature mismatch | Enter `maintenance`, coordinate the signing secret, then release Worker and Functions as one change. |
| Catalog drift | Keep pilot scope unchanged; run the read-only check, repair profiles/overrides/metafields, then recheck. |
| Suspected bad pricing | Enter `maintenance`; preserve evidence and test a known SKU before reopening. |
| GitHub deployment failure | Do not manually publish an untested version; diagnose the failed job and rerun from the reviewed commit. |

`disabled` permits native-price fallback and is a business-impacting choice, not the default
incident response. Use `maintenance` when uncertain so checkout fails safely.

## Current verified baseline

On 2026-11-04:

- `origin/main` was `8e9dacdebae0db612f792065b626f0af8d27b1c7`.
- Worker `/health` returned HTTP 200; active Worker version was
  `1a8c42e2-7627-40a6-bcd3-6e9ecbeccac1`.
- Shopify version `imprintid-dynamic-pricing-50` was active and named the same commit.
- The deployment's signing-secret fingerprint was `d23c73d4`.
- Production held 13,387 Shopify products, 147 pricing profiles, and 145 linked/enforcement-ready
  products. Two archived-only products remained intentionally unlinked.
- Enforcement mode was `pilot`; Order Workflows remained disabled and hidden.

This snapshot is evidence, not configuration. Repeat the checks above for every later release.

## Platform references

- [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Neon point-in-time recovery](https://neon.com/blog/point-in-time-recovery)
