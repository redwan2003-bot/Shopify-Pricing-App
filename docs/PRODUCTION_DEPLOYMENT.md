# Production Deployment & CI/CD Guide

This guide outlines the production architecture, Docker containerization, PostgreSQL database provisioning, and GitHub Actions CI/CD automation for **ImprintID Dynamic Pricing**.

---

## 1. Architecture Overview

```mermaid
graph TD
    ShopifyStore["Shopify Online Storefront"] -->|App Proxy /apps/imprintid-pricing| WebApp["React Router Web App Container"]
    WebApp -->|Prisma Client| PostgresDB[("Managed PostgreSQL Database")]
    GitHub["GitHub Repo: Shopify-Pricing-App"] -->|Push to main| Actions["GitHub Actions Runner (ubuntu-latest)"]
    Actions -->|Test & Validate| TestRun["904 Automated Tests"]
    Actions -->|Compile Wasm with Javy| Functions["Shopify Cart Transform & Validation Functions"]
    Actions -->|shopify app deploy| ShopifyPartners["Shopify Partner Platform"]
    Actions -->|Build & Push| GHCR["GitHub Container Registry / Docker Hub"]
```

---

## 2. GitHub Actions CI/CD Pipeline

The workflow is defined at [`.github/workflows/ci-cd.yml`](file:///C:/Users/reahs/Documents/imprintid-shopify-pricing/.github/workflows/ci-cd.yml).

### Workflow Jobs
1. **`validate-and-test`**:
   - Runs on `ubuntu-latest`.
   - Generates Prisma client for SQLite and PostgreSQL.
   - Runs `npm test` verifying all 904 test assertions.
   - Builds the production React Router bundle.
2. **`deploy-shopify-app`**:
   - Runs automatically on merge to `main`.
   - Compiles Shopify Functions (`javy` executes natively on Linux without Windows WDAC restrictions).
   - Deploys Theme App Extensions and Functions directly to Shopify with `shopify app deploy --allow-updates`.
3. **`build-docker-image`**:
   - Builds multi-platform Docker container using multi-stage [`Dockerfile`](file:///C:/Users/reahs/Documents/imprintid-shopify-pricing/Dockerfile).
   - Publishes image to GitHub Container Registry (`ghcr.io/<org>/Shopify-Pricing-App:latest`).

### Required GitHub Secrets
In your GitHub repository (`https://github.com/redwan2003-bot/Shopify-Pricing-App/settings/secrets/actions`), add the following:

| Secret Name | Purpose | Example / Source |
|---|---|---|
| `SHOPIFY_CLI_PARTNERS_TOKEN` | Token for non-interactive `shopify app deploy` | Generated in Shopify Partner Dashboard > Settings > Manage CLI tokens |
| `IMPRINTID_CART_SIGNING_SECRET` | 54-character signing secret | From `.env` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/dbname?schema=public` |

---

## 3. PostgreSQL Database Setup

### Schema & Migrations
- Development uses SQLite (`prisma/schema.prisma`).
- Production uses PostgreSQL (`prisma/schema.postgresql.prisma`).
- Pre-generated PostgreSQL migration is ready at [`prisma/migrations_postgresql/20260922000000_init_postgresql/migration.sql`](file:///C:/Users/reahs/Documents/imprintid-shopify-pricing/prisma/migrations_postgresql/20260922000000_init_postgresql/migration.sql).

### Deploying to PostgreSQL
To apply the schema to a new PostgreSQL instance:
```bash
npx prisma db push --schema=prisma/schema.postgresql.prisma
```

### Seeding Catalog Data
Run the catalog import script against the PostgreSQL database:
```bash
node --loader ts-node/esm scripts/import-catalog-pricing.ts
```

---

## 4. Production Web Service Hosting

### Option A: Railway / Render / Fly.io (Recommended)
1. Link your GitHub repository `https://github.com/redwan2003-bot/Shopify-Pricing-App`.
2. Add a PostgreSQL database service.
3. Configure the environment variables in your hosting dashboard:
   - `SHOPIFY_APP_URL=https://pricing.yourdomain.com`
   - `SHOPIFY_API_KEY=ff2a27051df6abf548cc227e021e97a4`
   - `SHOPIFY_API_SECRET=<your-secret>`
   - `SCOPES=write_products,write_cart_transforms,write_validations`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `IMPRINTID_CART_SIGNING_SECRET=<signing-secret>`
   - `IMPRINTID_ADJUSTMENT_VARIANT_ID=gid://shopify/ProductVariant/49349058199691`
   - `IMPRINTID_CART_ENVELOPE_VERSION=2`

### Option B: Docker Compose (VPS / AWS EC2 / DigitalOcean)
Copy [`docker-compose.prod.yml`](file:///C:/Users/reahs/Documents/imprintid-shopify-pricing/docker-compose.prod.yml) and `.env.production` to your server:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```
The included [`docker-entrypoint.sh`](file:///C:/Users/reahs/Documents/imprintid-shopify-pricing/docker-entrypoint.sh) automatically detects PostgreSQL, runs schema push/migrations, and launches the server.

---

## 5. Shopify App Proxy Configuration

Once the web service is deployed to a public HTTPS domain:
1. Update `application_url` in [`shopify.app.production.toml`](file:///C:/Users/reahs/Documents/imprintid-shopify-pricing/shopify.app.production.toml):
   ```toml
   application_url = "https://pricing.yourdomain.com"
   ```
2. Verify redirect and proxy URLs:
   ```toml
   [auth]
   redirect_urls = [ "https://pricing.yourdomain.com/api/auth" ]

   [app_proxy]
   url = "https://pricing.yourdomain.com/apps/imprintid-pricing"
   subpath = "imprintid-pricing"
   prefix = "apps"
   ```
3. Push the configuration to Shopify:
   ```bash
   shopify app deploy --config shopify.app.production.toml --allow-updates
   ```
