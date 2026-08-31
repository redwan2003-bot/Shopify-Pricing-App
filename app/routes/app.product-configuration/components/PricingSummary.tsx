import type { PricingCalculationOutcome } from "../../../lib/product-configuration/types.ts";
import { formatCents } from "../../../lib/product-configuration/format.ts";
import styles from "../styles.module.css";

export interface PricingSummaryProps {
  outcome: PricingCalculationOutcome;
}

/**
 * Displays a `PricingCalculationResult` the server already computed — this component
 * performs no arithmetic itself (STEP 11's "the UI only displays the result"). The
 * three non-success states (idle/loading/error) are rendered explicitly so a stale
 * price is never left on screen while the configuration no longer matches it.
 */
export function PricingSummary({ outcome }: PricingSummaryProps) {
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

      {outcome.status === "success" ? (
        <>
          <div className={styles.summaryRows}>
            <div className={styles.summaryRow}>
              <span className={styles.summaryRowLabel}>Quantity</span>
              <span className={styles.summaryRowValue}>{outcome.result.quantity.toLocaleString("en-US")}</span>
            </div>
            <div className={styles.summaryRow}>
              <span className={styles.summaryRowLabel}>Unit Price (List)</span>
              <span className={styles.summaryRowValue}>{formatCents(outcome.result.base.listUnitPriceCents)}</span>
            </div>
            {outcome.result.productColor ? (
              <div className={styles.summaryRow}>
                <span className={styles.summaryRowLabel}>Color — {outcome.result.productColor.name}</span>
                <span className={styles.summaryRowValue}>
                  {formatCents(outcome.result.productColor.priceAdjustmentCents) ?? "Price unavailable"}
                </span>
              </div>
            ) : null}
            {outcome.result.decoration ? (
              <div className={styles.summaryRow}>
                <span className={styles.summaryRowLabel}>Decoration</span>
                <span className={styles.summaryRowValue}>{formatCents(outcome.result.decoration.listChargesCents)}</span>
              </div>
            ) : null}
            {outcome.result.options.selections.length > 0 ? (
              <div className={styles.summaryRow}>
                <span className={styles.summaryRowLabel}>Options</span>
                <span className={styles.summaryRowValue}>{formatCents(outcome.result.options.chargesCents)}</span>
              </div>
            ) : null}
            <div className={styles.summaryRow}>
              <span className={styles.summaryRowLabel}>Production — {outcome.result.production.name}</span>
              <span className={styles.summaryRowValue}>
                {outcome.result.production.feeCents !== null
                  ? formatCents(outcome.result.production.feeCents)
                  : "Included"}
              </span>
            </div>
          </div>

          <hr className={styles.summaryDivider} />

          <div className={styles.summaryTotalRow}>
            <span className={styles.summaryTotalLabel}>Estimated Total (List)</span>
            <span className={styles.summaryTotalValue}>{formatCents(outcome.result.totals.listTotalCents)}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryRowLabel}>Net Total</span>
            <span className={styles.summaryRowValue}>{formatCents(outcome.result.totals.netTotalCents)}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}
