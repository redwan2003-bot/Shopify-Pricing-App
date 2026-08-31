import { Fragment, useEffect, useState } from "react";
import styles from "../styles.module.css";

export interface QuoteRequestModalProps {
  productTitle: string;
  sku: string;
  configurationSummary: Array<{ label: string; value: string }>;
  onClose: () => void;
}

const ARTWORK_STATUS_OPTIONS = ["Artwork ready", "Artwork needs revision", "No artwork yet"];

/**
 * Quote-request placeholder (STEP 14). Captures the fields the task specifies (product
 * configuration snapshot, customer info, shipping destination, artwork status,
 * additional notes) but — per explicit instruction — does NOT submit to any backend.
 * Submitting only shows a local confirmation panel; nothing is sent over the network or
 * persisted. A real quote pipeline (CRM/email/ticket integration) is a later phase.
 */
export function QuoteRequestModal({ productTitle, sku, configurationSummary, onClose }: QuoteRequestModalProps) {
  const [submitted, setSubmitted] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [shippingDestination, setShippingDestination] = useState("");
  const [artworkStatus, setArtworkStatus] = useState(ARTWORK_STATUS_OPTIONS[0]);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.modalBackdrop}>
      <button type="button" className={styles.modalBackdropClose} aria-label="Close dialog" onClick={onClose} />
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="quote-modal-heading">
        <h2 className={styles.modalHeading} id="quote-modal-heading">
          Request a Quote
        </h2>

        <dl className={styles.modalSummaryList}>
          <dt>Product</dt>
          <dd>{productTitle}</dd>
          <dt>SKU</dt>
          <dd>{sku}</dd>
          {configurationSummary.map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </Fragment>
          ))}
        </dl>

        {submitted ? (
          <div className={styles.modalConfirmation} role="status">
            Your quote request has been noted for follow-up. This is a UI preview only —
            no request was actually sent.
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
            }}
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            <div className={styles.modalField}>
              <label htmlFor="quote-name">Customer name</label>
              <input id="quote-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className={styles.modalField}>
              <label htmlFor="quote-email">Email</label>
              <input
                id="quote-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className={styles.modalField}>
              <label htmlFor="quote-shipping">Shipping destination</label>
              <input
                id="quote-shipping"
                value={shippingDestination}
                onChange={(e) => setShippingDestination(e.target.value)}
                placeholder="City, state/province, country"
              />
            </div>
            <div className={styles.modalField}>
              <label htmlFor="quote-artwork">Artwork status</label>
              <select
                id="quote-artwork"
                className={styles.select}
                value={artworkStatus}
                onChange={(e) => setArtworkStatus(e.target.value)}
              >
                {ARTWORK_STATUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.modalField}>
              <label htmlFor="quote-notes">Additional notes</label>
              <textarea id="quote-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.secondaryButton} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className={styles.primaryButton}>
                Submit Request
              </button>
            </div>
          </form>
        )}

        {submitted ? (
          <div className={styles.modalActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose}>
              Close
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
