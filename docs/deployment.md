# Deployment checklist

The app configuration now uses Shopify API version `2026-07`, which is the version
used by the Functions and current Shopify configuration examples in this project.

The application host is intentionally not fabricated in source control. Before using
the production config, set the same HTTPS origin in all three places:

1. `SHOPIFY_APP_URL` in the hosting provider.
2. `application_url` in `shopify.app.production.toml`.
3. The `/api/auth` redirect URL and `/apps/imprintid-pricing` proxy URL in that file.

Then deploy the configuration with the production config selected:

```shell
shopify app config use production
npm run deploy
```

The production environment must also provide `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SCOPES`, `DATABASE_URL`/the configured Prisma datasource, `IMPRINTID_CART_SIGNING_SECRET`,
`IMPRINTID_ADJUSTMENT_VARIANT_ID`, and `IMPRINTID_CART_ENVELOPE_VERSION=2`.

Do not enable universal enforcement until the Function resources, product policies,
currency, signing fingerprints, and live cart/checkout surfaces have been verified.
