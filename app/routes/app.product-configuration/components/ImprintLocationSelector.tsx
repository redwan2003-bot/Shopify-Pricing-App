import styles from "../styles.module.css";

export interface ImprintLocationSelectorProps {
  locations: 1 | 2;
  onChange: (locations: 1 | 2) => void;
  disabled?: boolean;
}

/** Front-only vs. front+back. Fixed to the range `DecorationSelectionInput.locations`
 * actually supports today — the calculation engine has pricing for at most a single
 * "2nd location" charge (see app/lib/pricing/calculator.ts); it is not derived from
 * per-product catalog data because the catalog does not expose a location dimension
 * (see app/lib/pricing-api/catalog.ts). This mirrors the same fixed range the Phase 2.6
 * storefront Theme App Extension already uses
 * (extensions/imprintid-dynamic-pricing/blocks/dynamic-pricing.liquid), so the two
 * surfaces stay consistent. */
export function ImprintLocationSelector({ locations, onChange, disabled }: ImprintLocationSelectorProps) {
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel} id="location-label">
        Imprint Location
      </span>
      <div className={styles.choiceRow} role="group" aria-labelledby="location-label">
        <button
          type="button"
          className={styles.choiceButton}
          data-selected={locations === 1}
          aria-pressed={locations === 1}
          disabled={disabled}
          onClick={() => onChange(1)}
        >
          Front Only
        </button>
        <button
          type="button"
          className={styles.choiceButton}
          data-selected={locations === 2}
          aria-pressed={locations === 2}
          disabled={disabled}
          onClick={() => onChange(2)}
        >
          Front + Back
        </button>
      </div>
    </div>
  );
}
