import type { PricingCatalogQuantityTier } from "../../../lib/pricing-api/catalog.ts";
import { formatCents } from "../../../lib/product-configuration/format.ts";
import { formatListRateLabel } from "../../../lib/product-configuration/view-model.ts";
import styles from "../styles.module.css";

export interface QuantitySelectorProps {
  tiers: PricingCatalogQuantityTier[];
  quantity: number;
  onChange: (quantity: number) => void;
  disabled?: boolean;
}

/** Clickable quantity tiers, sourced entirely from `catalog.quantityTiers` — no tier
 * values, rate codes or prices are embedded in this component, and none are recomputed
 * here: each button just shows the catalog's own `priceCode` and `listUnitPriceCents`
 * for that tier, inline with the quantity (e.g. "100 — List Price (6R) $2.29").
 *
 * Supports a custom quantity above the highest tier's minimum, since the calculation
 * engine itself resolves "the highest applicable tier" for any quantity at or above it
 * (see app/lib/pricing/calculator.ts). The custom-quantity control is deliberately kept
 * separate and unpriced — it is not a predefined tier and no price is guessed for it;
 * the server returns the real unit price once a custom quantity is chosen. */
export function QuantitySelector({ tiers, quantity, onChange, disabled }: QuantitySelectorProps) {
  const sorted = [...tiers].sort((a, b) => a.minQuantity - b.minQuantity);
  const lowestMinimum = sorted[0]?.minQuantity ?? 1;

  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel} id="quantity-label">
        Quantity
      </span>
      {sorted.length === 0 ? (
        <p className={styles.choiceEmpty}>No quantity tiers are configured for this product.</p>
      ) : (
        <div className={styles.tierRow} role="group" aria-labelledby="quantity-label">
          {sorted.map((tier) => {
            const isSelected = quantity === tier.minQuantity;
            const unitPrice = formatCents(tier.listUnitPriceCents);
            return (
              <button
                key={tier.minQuantity}
                type="button"
                className={styles.tierButton}
                data-selected={isSelected}
                aria-pressed={isSelected}
                disabled={disabled}
                onClick={() => onChange(tier.minQuantity)}
              >
                <span className={styles.tierQuantity}>{tier.minQuantity.toLocaleString("en-US")}</span>
                <span className={styles.tierRate}>
                  {formatListRateLabel(tier.priceCode)}
                  {unitPrice ? ` ${unitPrice}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className={styles.customQtyRow}>
        <label htmlFor="custom-quantity">Custom quantity</label>
        <input
          id="custom-quantity"
          className={styles.numberInput}
          type="number"
          min={lowestMinimum}
          step={1}
          value={quantity}
          disabled={disabled || sorted.length === 0}
          onChange={(event) => {
            const value = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(value) && value > 0) onChange(value);
          }}
        />
      </div>
    </div>
  );
}
