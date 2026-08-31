import { useState } from "react";
import styles from "../styles.module.css";

export interface ProductMediaImage {
  url: string;
  altText: string | null;
}

export interface ProductMediaProps {
  images: ProductMediaImage[];
  productTitle: string;
}

/** Image gallery. Renders real Shopify product images when a product could be resolved
 * for this SKU (see route.tsx's best-effort Admin GraphQL lookup); otherwise shows an
 * explicit "no product linked" placeholder rather than a fabricated image — LNY01 has
 * no linked Shopify product yet (see prisma/seed-data/README.md), so this is the honest
 * default state today, not a bug. */
export function ProductMedia({ images, productTitle }: ProductMediaProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = images[activeIndex] ?? null;

  return (
    <div className={styles.media}>
      <div className={styles.mediaFrame}>
        {active ? (
          <img
            className={styles.mediaImage}
            src={active.url}
            alt={active.altText || productTitle}
          />
        ) : (
          <div className={styles.mediaPlaceholder}>
            <span className={styles.mediaPlaceholderIcon} aria-hidden="true">
              🖼
            </span>
            <span>No product image available</span>
            <span>This SKU has no linked Shopify product yet.</span>
          </div>
        )}
      </div>
      {images.length > 1 ? (
        <div className={styles.thumbRow} role="tablist" aria-label="Product images">
          {images.map((image, index) => (
            <button
              key={image.url}
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              className={styles.thumb}
              data-active={index === activeIndex}
              onClick={() => setActiveIndex(index)}
            >
              <img src={image.url} alt={image.altText || `${productTitle} view ${index + 1}`} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
