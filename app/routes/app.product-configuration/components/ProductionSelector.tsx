import type { PricingCatalogProductionRule } from "../../../lib/pricing-api/catalog.ts";
import styles from "../styles.module.css";

export interface ProductionSelectorProps {
  rules: PricingCatalogProductionRule[];
  selectedCode: string | null;
  onChange: (code: string) => void;
  disabled?: boolean;
}

function describeLeadTime(rule: PricingCatalogProductionRule): string {
  if (rule.maxBusinessDays && rule.maxBusinessDays !== rule.minBusinessDays) {
    return `${rule.minBusinessDays}–${rule.maxBusinessDays} business days`;
  }
  return `${rule.minBusinessDays} business day${rule.minBusinessDays === 1 ? "" : "s"}`;
}

/** Production/turnaround choices — sourced entirely from `catalog.productionRules`
 * (real `ProductionRule` rows). `feeCents` is only shown when a fee was actually
 * supplied; `null` renders as "Fee not available" rather than a fabricated "Included"
 * or "$0.00" — see ProductionRule's null-means-not-supplied convention. */
export function ProductionSelector({ rules, selectedCode, onChange, disabled }: ProductionSelectorProps) {
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel} id="production-label">
        Production
      </span>
      {rules.length === 0 ? (
        <p className={styles.choiceEmpty}>No production options are configured for this product.</p>
      ) : (
        <div className={styles.choiceRow} role="group" aria-labelledby="production-label">
          {rules.map((rule) => (
            <button
              key={rule.code}
              type="button"
              className={styles.choiceButton}
              data-selected={selectedCode === rule.code}
              aria-pressed={selectedCode === rule.code}
              disabled={disabled}
              onClick={() => onChange(rule.code)}
            >
              {rule.name}
              <span className={styles.choiceMeta}>
                {describeLeadTime(rule)}
                {rule.feeCents !== null
                  ? ` · +$${(rule.feeCents / 100).toFixed(2)}`
                  : rule.isRush
                    ? " · fee not available"
                    : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
