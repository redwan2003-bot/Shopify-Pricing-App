import styles from "../styles.module.css";

export interface DecorationOptionsTogglesProps {
  reverseSide: boolean;
  differentReverseArtwork: boolean;
  repeatOrder: boolean;
  onReverseSideChange: (value: boolean) => void;
  onDifferentReverseArtworkChange: (value: boolean) => void;
  onRepeatOrderChange: (value: boolean) => void;
  disabled?: boolean;
}

/** The three boolean decoration axes the engine's `DecorationSelectionInput` supports
 * beyond color/location count. "Different reverse artwork" only applies when reverse
 * side printing is on, so it's hidden (and forced off) otherwise — the same behavior
 * the storefront Theme App Extension implements. */
export function DecorationOptionsToggles({
  reverseSide,
  differentReverseArtwork,
  repeatOrder,
  onReverseSideChange,
  onDifferentReverseArtworkChange,
  onRepeatOrderChange,
  disabled,
}: DecorationOptionsTogglesProps) {
  return (
    <div className={styles.section}>
      <span className={styles.sectionLabel}>Additional Options</span>
      <div className={styles.checkboxRow}>
        <input
          id="reverse-side"
          type="checkbox"
          checked={reverseSide}
          disabled={disabled}
          onChange={(event) => onReverseSideChange(event.target.checked)}
        />
        <label htmlFor="reverse-side">Print on reverse side</label>
      </div>
      {reverseSide ? (
        <div className={styles.checkboxRow}>
          <input
            id="different-reverse-artwork"
            type="checkbox"
            checked={differentReverseArtwork}
            disabled={disabled}
            onChange={(event) => onDifferentReverseArtworkChange(event.target.checked)}
          />
          <label htmlFor="different-reverse-artwork">Reverse side uses different artwork</label>
        </div>
      ) : null}
      <div className={styles.checkboxRow}>
        <input
          id="repeat-order"
          type="checkbox"
          checked={repeatOrder}
          disabled={disabled}
          onChange={(event) => onRepeatOrderChange(event.target.checked)}
        />
        <label htmlFor="repeat-order">This is a repeat order</label>
      </div>
    </div>
  );
}
