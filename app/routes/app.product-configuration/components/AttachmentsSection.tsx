import { useMemo } from "react";
import type { PricingCatalogOptionGroup } from "../../../lib/pricing-api/catalog.ts";
import { OptionGroupSelector } from "./OptionGroupSelector.tsx";
import styles from "../styles.module.css";

export interface AttachmentsSectionProps {
  groups: PricingCatalogOptionGroup[];
  selectedOptionValueIds: Record<string, string>;
  onOptionChange: (groupName: string, optionValueId: string | null) => void;
  disabled?: boolean;
}

/**
 * All ATTACHMENT-kind option groups collapsed into ONE clickable "Attachments"
 * disclosure. Selection behaviour is unchanged — each category is still its own
 * independent `OptionGroup` selector inside the panel (a choice per category, summed by
 * the calculator exactly as before) — this only groups the five stacked top-level
 * sections into a single expandable box. Matches the storefront block, which does the
 * same with a `<details class="imprintid-pricing__attachments">`.
 */
export function AttachmentsSection({ groups, selectedOptionValueIds, onOptionChange, disabled }: AttachmentsSectionProps) {
  const selectedCount = useMemo(
    () => groups.filter((group) => selectedOptionValueIds[group.name]).length,
    [groups, selectedOptionValueIds],
  );

  if (groups.length === 0) return null;

  return (
    <details className={styles.section} open={selectedCount > 0}>
      <summary className={styles.disclosureSummary}>
        <span className={styles.sectionLabel}>Attachments</span>
        <span className={styles.choiceMeta}>
          {selectedCount > 0
            ? `${selectedCount} selected`
            : `${groups.length} ${groups.length === 1 ? "category" : "categories"}`}
        </span>
      </summary>
      <div className={styles.disclosureBody}>
        {groups.map((group) => (
          <OptionGroupSelector
            key={group.name}
            group={group}
            selectedOptionValueId={selectedOptionValueIds[group.name] ?? null}
            onChange={(optionValueId) => onOptionChange(group.name, optionValueId)}
            disabled={disabled}
          />
        ))}
      </div>
    </details>
  );
}
