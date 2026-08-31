import { useState } from "react";
import type { PricingCalculationOutcome } from "../../../lib/product-configuration/types.ts";
import styles from "../styles.module.css";

export interface ActionButtonsProps {
  outcome: PricingCalculationOutcome;
  onRequestQuote: () => void;
}

type AddToCartState = "idle" | "loading" | "success" | "error";

const ADD_TO_CART_LABEL: Record<AddToCartState, string> = {
  idle: "Add to Cart",
  loading: "Adding…",
  success: "Added to Cart",
  error: "Try Again",
};

/**
 * Primary ("Add to Cart") and secondary ("Request a Quote") CTAs.
 *
 * IMPLEMENTED (this component): validation against the real calculation outcome, the
 * loading/success/error interaction states themselves, and preventing a submission
 * while pricing is loading or failed.
 *
 * NOT YET IMPLEMENTED: an actual Shopify cart/checkout write. There is no real backend
 * for "Add to Cart" in this admin preview — clicking it only proves out the interaction
 * states described in the Phase 2 spec (STEP 13); no network request is made and
 * nothing is persisted. Wiring this to a real cart requires a storefront (not embedded
 * admin) checkout surface, deliberately out of scope for this phase (see STEP 26).
 */
export function ActionButtons({ outcome, onRequestQuote }: ActionButtonsProps) {
  const [addState, setAddState] = useState<AddToCartState>("idle");

  const requiresQuote = outcome.status === "error";
  const canAddToCart = outcome.status === "success";
  const isBusy = addState === "loading";

  async function handleAddToCart() {
    if (!canAddToCart || isBusy) return;
    setAddState("loading");
    // Simulates interaction timing only — see the NOT YET IMPLEMENTED note above. No
    // network request is made here.
    await new Promise((resolve) => setTimeout(resolve, 450));
    setAddState("success");
    window.setTimeout(() => setAddState("idle"), 2200);
  }

  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.primaryButton}
        data-state={addState !== "idle" ? addState : undefined}
        disabled={!canAddToCart || isBusy}
        aria-disabled={!canAddToCart || isBusy}
        onClick={handleAddToCart}
      >
        {ADD_TO_CART_LABEL[addState]}
      </button>
      {requiresQuote ? (
        <p className={styles.quoteRequiredNote}>This configuration requires a custom quote.</p>
      ) : null}
      <button type="button" className={styles.secondaryButton} onClick={onRequestQuote}>
        Request a Quote
      </button>
    </div>
  );
}
