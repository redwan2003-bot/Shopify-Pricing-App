import styles from "../styles.module.css";

export interface ColorCountSelectorProps {
  colors: 1 | 2;
  onChange: (colors: 1 | 2) => void;
  disabled?: boolean;
}

/** Number of imprint colors. Fixed to {1, 2+} for the same reason
 * `ImprintLocationSelector` fixes its range — see that component's doc comment. The
 * calculation engine independently prices color 2, 3, 4, ... via `DecorationColorCharge`
 * (Phase 2.7) when a product actually has that data configured; this selector's range
 * is a UI constant reflecting what the two shipped surfaces (this admin preview and the
 * storefront extension) currently expose, not a per-product pricing fact. */
export function ColorCountSelector({ colors, onChange, disabled }: ColorCountSelectorProps) {
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel} id="color-count-label">
        Number of Colors
      </span>
      <div className={styles.choiceRow} role="group" aria-labelledby="color-count-label">
        <button
          type="button"
          className={styles.choiceButton}
          data-selected={colors === 1}
          aria-pressed={colors === 1}
          disabled={disabled}
          onClick={() => onChange(1)}
        >
          1 Color
        </button>
        <button
          type="button"
          className={styles.choiceButton}
          data-selected={colors === 2}
          aria-pressed={colors === 2}
          disabled={disabled}
          onClick={() => onChange(2)}
        >
          2+ Colors
        </button>
      </div>
    </div>
  );
}
