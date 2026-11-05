# Billing Architecture — Retired

Status: **not applicable to the current operating model** (confirmed 2026-11-04).

ImprintID Dynamic Pricing is owner-operated and non-billed. It is not being prepared as a paid
public App Store listing. The experimental $29.99/month design from September 2026 was removed in
commit `0e0fa8d` and must not be treated as production behavior.

Current rules:

- No Shopify subscriptions are created, checked, or cancelled.
- No page or pricing-profile action is gated by payment status.
- There is no Billing navigation item or billing route.
- Storefront pricing and checkout enforcement depend on catalog policy and enforcement mode, not
  merchant entitlement.

If the app is commercialized later, billing requires a new business decision, architecture
review, real-store billing tests, merchant-facing cancellation behavior, and a new release gate.
Do not restore the retired implementation piecemeal.

See `docs/PRODUCTION_OPERATIONS.md` for the current operating model and release procedure.
