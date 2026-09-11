import { Fragment, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Modal, TitleBar } from "@shopify/app-bridge-react";
import type { SelectedConfigurationRow } from "../../../lib/product-configuration/view-model.ts";
import styles from "../styles.module.css";

export interface QuoteRequestModalProps {
  productTitle: string;
  sku: string;
  /** The shared, normalized selected-configuration rows (same view model the Price
   * Summary renders) — not a separately hand-built label set. */
  configurationSummary: SelectedConfigurationRow[];
  onClose: () => void;
}

const ARTWORK_STATUS_OPTIONS = ["Artwork ready", "Artwork needs revision", "No artwork yet"];
const MODAL_ID = "imprintid-quote-request-modal";

/**
 * Quote-request placeholder (STEP 14). Captures the fields the task specifies (product
 * configuration snapshot, customer info, shipping destination, artwork status,
 * additional notes) but — per explicit instruction — does NOT submit to any backend.
 * Submitting only shows a local confirmation panel; nothing is sent over the network or
 * persisted. A real quote pipeline (CRM/email/ticket integration) is a later phase.
 *
 * Rendered as a Shopify App Bridge `Modal` + `TitleBar` (this route runs embedded in
 * Shopify Admin). App Bridge renders the overlay at the top level of Admin — centred in
 * the merchant's real viewport, dimming the whole interface, with a focus trap and X /
 * Escape / backdrop dismissal that all fire `onHide`. The previous hand-rolled
 * `position: fixed` overlay could not escape the embedded-app iframe, so it appeared
 * off-screen on a scrolled page.
 */
export function QuoteRequestModal({ productTitle, sku, configurationSummary, onClose }: QuoteRequestModalProps) {
  const [submitted, setSubmitted] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [shippingDestination, setShippingDestination] = useState("");
  const [artworkStatus, setArtworkStatus] = useState(ARTWORK_STATUS_OPTIONS[0]);
  const [notes, setNotes] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted) return; // pending-state protection: a second submission is never processed
    setSubmitted(true);
  }

  return (
    <Modal id={MODAL_ID} open onHide={onClose} variant="base">
      <div className={styles.modalBody}>
        <dl className={styles.modalSummaryList}>
          <dt>Product</dt>
          <dd>{productTitle}</dd>
          <dt>SKU</dt>
          <dd>{sku}</dd>
          {configurationSummary.map((row) => (
            <Fragment key={row.key}>
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
          <form ref={formRef} id="imprintid-quote-request-form" onSubmit={handleSubmit} className={styles.modalForm}>
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
          </form>
        )}
      </div>

      <TitleBar title="Request a Quote">
        {submitted ? (
          <button variant="primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button onClick={onClose}>Cancel</button>
            <button variant="primary" onClick={() => formRef.current?.requestSubmit()}>
              Submit Request
            </button>
          </>
        )}
      </TitleBar>
    </Modal>
  );
}
