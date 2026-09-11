import type { PricingCalculationOutcome } from "../../../lib/product-configuration/types.ts";
import type { SelectedConfigurationRow } from "../../../lib/product-configuration/view-model.ts";
import { formatCents } from "../../../lib/product-configuration/format.ts";
import styles from "../styles.module.css";

export interface PricingSummaryProps {
  outcome: PricingCalculationOutcome;
  /** The shared, normalized "what did the merchant configure" rows — built once in the
   * route from `buildSelectedConfigurationRows` and also fed to the Request-a-Quote
   * snapshot, so the two never disagree. Display-only; carries no amounts this component
   * calculates. */
  selectedConfigurationRows: SelectedConfigurationRow[];
}

/**
 * Displays a `PricingCalculationResult` the server already computed — this component
 * performs no arithmetic itself (STEP 11's "the UI only displays the result"). The
 * three non-success states (idle/loading/error) are rendered explicitly so a stale
 * price is never left on screen while the configuration no longer matches it.
 *
 * On success it renders two clearly separated blocks:
 *  - **Selected Configuration** — every current selection as human-readable label/value
 *    rows (quantity + resolved unit price, product color, decoration axes, optional
 *    feature groups, production, packaging …), from the shared view model.
 *  - **Pricing Breakdown** — the financial figures: base subtotal, each charge line,
 *    the estimated total and net total. Every amount here comes straight from the
 *    authoritative `PricingCalculationResult`; nothing is recomputed. The unit price is
 *    shown once only — inline in the Selected Configuration Quantity row — never
 *    repeated as its own breakdown line.
 */
export function PricingSummary({ outcome, selectedConfigurationRows }: PricingSummaryProps) {
  const result = outcome.status === "success" ? outcome.result : null;

  return (
    <div className={styles.summary} aria-live="polite">
      <p className={styles.summaryHeading}>Price Summary</p>

      {outcome.status === "idle" ? <p className={styles.summaryEmpty}>Choose a quantity to see pricing.</p> : null}

      {outcome.status === "loading" ? <p className={styles.summaryLoading}>Calculating price…</p> : null}

      {outcome.status === "error" ? (
        <div className={styles.summaryError} role="alert">
          <strong>Unable to calculate pricing.</strong>
          <span>{outcome.message}</span>
        </div>
      ) : null}

      {result ? (
        <>
          <section className={styles.summarySection} aria-label="Selected configuration">
            <p className={styles.summarySubheading}>Selected Configuration</p>
            <dl className={styles.configList}>
              {selectedConfigurationRows.map((row) => (
                <div className={styles.configRow} key={row.key}>
                  <dt className={styles.configTerm}>{row.label}</dt>
                  <dd className={styles.configDetail}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className={styles.summarySection} aria-label="Pricing breakdown">
            <p className={styles.summarySubheading}>Pricing Breakdown</p>
            <div className={styles.summaryRows}>
              <div className={styles.summaryRow}>
                <span className={styles.summaryRowLabel}>Base subtotal</span>
                <span className={styles.summaryRowValue}>{formatCents(result.base.listSubtotalCents)}</span>
              </div>
              {result.productColor ? (
                <div className={styles.summaryRow}>
                  <span className={styles.summaryRowLabel}>Product color — {result.productColor.name}</span>
                  <span className={styles.summaryRowValue}>
                    {formatCents(result.productColor.priceAdjustmentCents) ?? "Price unavailable"}
                  </span>
                </div>
              ) : null}
              {result.decoration ? (
                <div className={styles.summaryRow}>
                  <span className={styles.summaryRowLabel}>Decoration</span>
                  <span className={styles.summaryRowValue}>{formatCents(result.decoration.listChargesCents)}</span>
                </div>
              ) : null}
              {result.options.selections.length > 0 ? (
                <div className={styles.summaryRow}>
                  <span className={styles.summaryRowLabel}>Options</span>
                  <span className={styles.summaryRowValue}>{formatCents(result.options.chargesCents)}</span>
                </div>
              ) : null}
              <div className={styles.summaryRow}>
                <span className={styles.summaryRowLabel}>Production — {result.production.name}</span>
                <span className={styles.summaryRowValue}>
                  {result.production.feeCents !== null ? formatCents(result.production.feeCents) : "Included"}
                </span>
              </div>
              {result.packaging ? (
                <div className={styles.summaryRow}>
                  <span className={styles.summaryRowLabel}>Packaging — {result.packaging.name}</span>
                  <span className={styles.summaryRowValue}>
                    {result.packaging.feeCents !== null ? formatCents(result.packaging.feeCents) : "Included"}
                  </span>
                </div>
              ) : null}
            </div>

            <hr className={styles.summaryDivider} />

            <div className={styles.summaryTotalRow}>
              <span className={styles.summaryTotalLabel}>Estimated Total (List)</span>
              <span className={styles.summaryTotalValue}>{formatCents(result.totals.listTotalCents)}</span>
            </div>
            <div className={styles.summaryRow}>
              <span className={styles.summaryRowLabel}>Net Total</span>
              <span className={styles.summaryRowValue}>{formatCents(result.totals.netTotalCents)}</span>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
