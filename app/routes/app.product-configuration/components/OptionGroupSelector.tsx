import type { PricingCatalogOptionGroup } from "../../../lib/pricing-api/catalog.ts";
import styles from "../styles.module.css";

export interface OptionGroupSelectorProps {
  group: PricingCatalogOptionGroup;
  selectedOptionValueId: string | null;
  onChange: (optionValueId: string | null) => void;
  disabled?: boolean;
}

function describePrice(
  value: PricingCatalogOptionGroup["values"][number],
  categoryPriceAdjustmentCents: number | null,
): string | null {
  const priceCents = value.priceAdjustmentCents ?? categoryPriceAdjustmentCents;
  if (priceCents === null) return "Price unavailable";
  if (priceCents === 0) return "Included";
  return `+$${(priceCents / 100).toFixed(2)}`;
}

/**
 * Renders one `OptionGroup` (Attachment, Feature, or Generic — see `OptionGroupKind`)
 * as a set of selectable values. Reused for every group kind rather than having a
 * separate `AttachmentSelector` and `FeatureSelector` — the underlying data and
 * selection behavior are identical (both are just `OptionGroup`/`OptionValue`, per the
 * Phase 2.7 decision not to duplicate Attachment into its own table). Distinguishes
 * "confirmed $0", "a real price", and "price unavailable" per-value, exactly matching
 * the null-vs-zero convention `app/lib/pricing/types.ts` documents — never silently
 * shows an unavailable price as free.
 */
export function OptionGroupSelector({ group, selectedOptionValueId, onChange, disabled }: OptionGroupSelectorProps) {
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel} id={`option-group-${group.name}`}>
        {group.name}
        {group.isRequired ? " (required)" : ""}
      </span>
      {group.values.length === 0 ? (
        <p className={styles.choiceEmpty}>No options are configured for this group.</p>
      ) : (
        <div className={styles.choiceRow} role="group" aria-labelledby={`option-group-${group.name}`}>
          {!group.isRequired ? (
            <button
              type="button"
              className={styles.choiceButton}
              data-selected={selectedOptionValueId === null}
              aria-pressed={selectedOptionValueId === null}
              disabled={disabled}
              onClick={() => onChange(null)}
            >
              None
            </button>
          ) : null}
          {group.values.map((value) => (
            <button
              key={value.id}
              type="button"
              className={styles.choiceButton}
              data-selected={selectedOptionValueId === value.id}
              aria-pressed={selectedOptionValueId === value.id}
              disabled={disabled}
              onClick={() => onChange(value.id)}
            >
              {value.label}
              <span className={styles.choiceMeta}>{describePrice(value, group.categoryPriceAdjustmentCents)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
