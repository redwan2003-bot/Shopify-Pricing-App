import type { PricingCatalogProductColor } from "../../../lib/pricing-api/catalog.ts";
import styles from "../styles.module.css";

export interface ProductColorSelectorProps {
  colors: PricingCatalogProductColor[];
  selectedCode: string | null;
  onChange: (code: string | null) => void;
  disabled?: boolean;
}

/** Product color choices. Renders nothing when the catalog has no configured colors —
 * true for LNY01 today (see docs/pricing-model-expansion.md, "Product color" — no color
 * pricing/availability data has ever been sourced for it). The control exists generically
 * for any product that does configure `ProductColor` rows, exactly mirroring the
 * conditional-render pattern already shipped in the storefront Theme App Extension. */
export function ProductColorSelector({ colors, selectedCode, onChange, disabled }: ProductColorSelectorProps) {
  if (colors.length === 0) return null;

  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel} id="product-color-label">
        Product Color
      </span>
      <div className={styles.choiceRow} role="group" aria-labelledby="product-color-label">
        <button
          type="button"
          className={styles.choiceButton}
          data-selected={selectedCode === null}
          aria-pressed={selectedCode === null}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          None
        </button>
        {colors.map((color) => (
          <button
            key={color.code}
            type="button"
            className={styles.choiceButton}
            data-selected={selectedCode === color.code}
            aria-pressed={selectedCode === color.code}
            disabled={disabled}
            onClick={() => onChange(color.code)}
          >
            {color.name}
            {color.priceAdjustmentCents ? (
              <span className={styles.choiceMeta}>+${(color.priceAdjustmentCents / 100).toFixed(2)}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
