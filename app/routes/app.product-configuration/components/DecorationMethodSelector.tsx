import styles from "../styles.module.css";

export interface DecorationMethodSelectorProps {
  methods: string[];
  selected: string | null;
  onChange: (method: string) => void;
  disabled?: boolean;
}

const METHOD_LABELS: Record<string, string> = {
  SCREEN_PRINT: "Screen Print",
  EMBROIDERY: "Embroidery",
  DTF: "DTF",
  DTG: "DTG",
  VINYL: "Vinyl",
  SUBLIMATION: "Sublimation",
  OTHER: "Other",
};

/** Decoration method choices — sourced from `catalog.decorationMethods`, which is
 * derived from the real `DecorationRule` rows configured for this product (see
 * app/lib/pricing-api/catalog.ts). A product with only Screen Print configured shows
 * only Screen Print; this component never presents a method the product doesn't
 * actually support. */
export function DecorationMethodSelector({ methods, selected, onChange, disabled }: DecorationMethodSelectorProps) {
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel} id="decoration-method-label">
        Decoration Method
      </span>
      {methods.length === 0 ? (
        <p className={styles.choiceEmpty}>No decoration methods are configured for this product.</p>
      ) : (
        <div className={styles.choiceRow} role="group" aria-labelledby="decoration-method-label">
          {methods.map((method) => {
            const isSelected = selected === method;
            return (
              <button
                key={method}
                type="button"
                className={styles.choiceButton}
                data-selected={isSelected}
                aria-pressed={isSelected}
                disabled={disabled}
                onClick={() => onChange(method)}
              >
                {METHOD_LABELS[method] ?? method}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
