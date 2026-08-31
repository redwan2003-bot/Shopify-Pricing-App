import type { PricingCatalogQuantityTier } from "../../../lib/pricing-api/catalog.ts";
import styles from "../styles.module.css";

export interface QuantitySelectorProps {
  tiers: PricingCatalogQuantityTier[];
  quantity: number;
  onChange: (quantity: number) => void;
  disabled?: boolean;
}

/** Clickable quantity tiers, sourced entirely from `catalog.quantityTiers` — no tier
 * values are embedded in this component. Supports a custom quantity above the highest
 * tier's minimum, since the calculation engine itself resolves "the highest applicable
 * tier" for any quantity at or above it (see app/lib/pricing/calculator.ts). Does not
 * calculate a price itself — selecting a tier only updates the configuration state; the
 * server produces the actual price. */
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
                {tier.minQuantity.toLocaleString("en-US")}
                <span className={styles.tierUnit}>{tier.maxQuantity ? `– ${tier.maxQuantity.toLocaleString("en-US")}` : "+"}</span>
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
