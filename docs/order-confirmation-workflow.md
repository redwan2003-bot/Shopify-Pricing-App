# ImprintID order-confirmation workflow

## Phase 1: signed pricing and configuration persistence

The storefront pricing block must issue a signed v2 quote before adding an enforced
product to cart. It stores the signed payload, signature, version, and normalized
configuration in private line properties. The `orders/create` webhook copies those
properties into `OrderWorkflow` and `OrderConfiguration` rows, creating an auditable
pricing snapshot that later artwork and proof steps cannot silently change.

Orders begin in `received`. A missing or malformed signed quote is persisted as
`quoteEnvelopePresent = false`; it is never treated as a valid dynamic-price order.

## Phase 2: artwork and PO intake

Add an authenticated merchant/customer intake route that accepts:

- PO number and customer contact
- product configuration and signed quote reference
- PMS/imprint instructions and attachment selections
- event/in-hands date and full ship-to address
- artwork files with extension and size validation

The workflow data model stores PO fields and artwork metadata. Files must be uploaded to
a private object store by the hosting integration; only the durable object key, checksum,
and validated metadata belong in the database. The intake service moves the workflow to
`artwork_pending`. Do not email or expose files from a public URL.

### Private storage implementation

Production uses a private Cloudflare R2 bucket through the S3-compatible API.
The application never writes artwork or proofs to Render's local filesystem.
It creates short-lived presigned `PUT` URLs for uploads and presigned `GET`
URLs for staff/customer access. Object keys are restricted to
`orders/<workflow-id>/artwork/...` or `orders/<workflow-id>/proofs/...` and the
bucket remains private. Configure `R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_REGION=auto` in the runtime
secret manager; do not commit credentials.

The authenticated intake endpoint is `/api/order-intake`; it accepts PO/order metadata
and validated private object-storage metadata. It does not accept arbitrary public URLs.

## Phase 3: proof approval and production state

The proof service creates versioned proof records with hashed, expiring approval tokens.
The customer may approve or request a revision through the token. Approval is recorded
with timestamp and actor; revision requests retain the previous proof and written reason.
Only an approved proof may move the workflow to `production`. Shipment events move it to
`shipped`, and a tracking number completes the customer-facing confirmation.

The customer proof endpoint is `/api/proof/:token` with `action: "approve"` or
`action: "revision"`. Staff production transitions use `/api/order-workflows/:id` and
allow only `production`, `shipped`, and `completed` in the state machine.

Required state transitions are:

`received -> artwork_pending -> proof_ready -> revision_requested -> proof_ready -> approved -> production -> shipped -> completed`

Every transition must be validated server-side and recorded in an append-only audit
log. A Shopify order webhook or staff-created order without a valid signed quote must
not be silently upgraded into a dynamically priced production order.

## Deployment note

Phase 1 adds the `read_orders` scope and an `orders/create` webhook subscription in both
Shopify TOML configurations. Deploying that configuration will require the normal
Shopify scope reauthorization flow; this change has not been deployed by this phase.
