import type { PricingCalculationResult } from "../pricing/index.ts";
import type { PricingCatalog } from "../pricing-api/catalog.ts";

/**
 * The customer's in-progress selections for the Phase 2 "Product Configuration" admin
 * preview (`app/routes/app.product-configuration`). This is UI state only — it holds no
 * prices. A `ProductConfigurationState` is turned into a `CalculationInput` (see
 * `buildCalculationRequestBody` in `request-body.ts`) and sent to the server, which is
 * the only place a `PricingCalculationResult` (the priced result) is produced.
 *
 * `colors`/`locations` are fixed to the range the calculation engine actually supports
 * today (`DecorationSelectionInput` — see `app/lib/pricing/types.ts`), not derived from
 * catalog data — the same convention the Phase 2.6 storefront Theme App Extension
 * already uses (see `extensions/imprintid-dynamic-pricing/blocks/dynamic-pricing.liquid`).
 */
export interface ProductConfigurationState {
  quantity: number;
  decorationMethod: string | null;
  colors: 1 | 2;
  locations: 1 | 2;
  reverseSide: boolean;
  differentReverseArtwork: boolean;
  repeatOrder: boolean;
  productColorCode: string | null;
  /** OptionGroup.name -> selected OptionValue.id. Absent entry = nothing selected for
   * that group. */
  selectedOptionValueIds: Record<string, string>;
  productionCode: string | null;
}

/**
 * The outcome of the most recent price calculation round-trip to the server. Mirrors
 * the shape `POST /app/product-configuration` (this route's own action) returns —
 * see `app/lib/pricing-api/response.ts`, which this route reuses unchanged.
 */
export type PricingCalculationOutcome =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: PricingCalculationResult }
  | { status: "error"; code: string; message: string };

export type { PricingCatalog };
