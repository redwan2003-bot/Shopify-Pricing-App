# `scripts/shopify/` — phased development-store provisioning (Task 5B.3B.2)

Tracked, reviewable replacement for the old one-step `.shopify/provision-5b3b.mjs --apply`.

Talks **only** to the ImprintID app's own offline Admin session for
`imprintid-pricing-development.myshopify.com` (loaded from the local Prisma `Session`
table — never the Shopify Claude Connector, whose `$app:` namespace belongs to a
different app). The store is hard-coded in `constants.mjs`; no argument or environment
variable can retarget it, so a production store is unreachable. The Admin token, the
signing secret, and authenticated URLs are never printed — only SHA-256 fingerprint
prefixes.

## Files

| file | role |
|---|---|
| `constants.mjs` | the one dev store + the exact resource shapes. No secrets. |
| `reconcile.mjs` | **pure** — state classification, phase plans, idempotency + ordering gates, rollback plan. Unit-tested in `test/shopify-provision/`. |
| `runtime.mjs` | IO — Prisma auth + `gql()`, the read-only state snapshot, `.env` / Function-config fingerprints, the git-ignored receipt. |
| `phases.mjs` | the five phase orchestrations (deps injected → unit-tested with a fake Admin client). |
| `provision.mjs` | CLI entry. |

## Phases — strict ordering, no phase silently performs a later one

```
node scripts/shopify/provision.mjs --check          # read-only report (default). NEVER mutates, NEVER exits early.
node scripts/shopify/provision.mjs --prepare        # adjustment product/variant + .env secret + metafield defs + policy VALUES
node scripts/shopify/provision.mjs --activate       # ONE Cart Transform + ONE Validation (blockOnFailure). Enforcement stays OFF.
node scripts/shopify/provision.mjs --enable-pilot   # flip enforcement_policy.enabled -> true (pilot; LNY01 only; NEVER universal)
node scripts/shopify/provision.mjs --rollback-check # print an exact rollback plan; execute nothing
```

### A. `--prepare`
Reconciles/creates the adjustment product + its single variant (price `0.01`,
`inventoryPolicy: CONTINUE`, untracked, no shipping, not taxable, unpublished); writes
the git-ignored `.env` (`IMPRINTID_CART_ENVELOPE_VERSION=2`, a generated
`IMPRINTID_CART_SIGNING_SECRET` — reused if already present, never printed,
`IMPRINTID_ADJUSTMENT_VARIANT_ID`); creates the two app-owned metafield definitions;
writes the shop `enforcement_policy` (**`enabled: false`**) and the LNY01
`pricing_policy`. **Does not** create the Cart Transform or an active Validation.

### B. Manual compilation boundary
1. `npm run fn:config` — bakes the **same** secret into both Functions, read from `.env`
   (no secret on the command line).
2. Restart `npm run dev` (Ctrl+C, then run it again).
3. `node scripts/shopify/provision.mjs --check` — confirm the three signing-secret
   fingerprints (app server + both Functions) match.

### C. `--activate`
Refuses to run unless: the receipt shows `prepared`+, the live store still shows the
prepared resources with enforcement **disabled**, there are no foreign resources, **and
all three signing-secret fingerprints are equal and non-empty**. Then creates exactly
one Cart Transform and one Validation, both `blockOnFailure: true`. Enforcement stays
disabled.

### D. `--enable-pilot`
Refuses to run unless the Cart Transform and Validation both read back correctly
(present, `blockOnFailure`, Validation enabled) **and** the pricing-profile currency
equals the shop currency (the initial release performs **no** currency conversion).
Sets `enforcement_policy.enabled: true` (mode stays `pilot`; only LNY01 carries a
product policy, so only LNY01 is enforced). Never `universal`.

## Idempotency

Every `--prepare` rerun reconciles the adjustment product/variant **in place** (price,
inventory policy, tracking, shipping, taxable, publication, status, tags), the metafield
definitions, and the policy values. It repairs safe partial state that belongs to this
provisioner and **stops** on any foreign or ambiguous resource (more than one adjustment
product, a variant count ≠ 1, an Online-Store publication, a foreign Cart Transform or
Validation). `--activate` / `--enable-pilot` reuse existing resources.

## Recovery receipt

`--prepare` / `--activate` / `--enable-pilot` write `.shopify/provision-receipt.json`
(git-ignored, **non-secret** — canonical app + store, phase reached, created/reused
resource ids, before/after policy state, Transform + Validation ids, the signing-secret
**fingerprint only**, timestamps, script version). The token and secret are never
stored. `--rollback-check` reads it and prints an exact, ordered rollback plan that
references only ids the receipt recorded — and executes nothing.
