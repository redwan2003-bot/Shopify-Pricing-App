import styles from "../styles.module.css";

export interface ProductHeaderProps {
  title: string;
  sku: string;
  description: string | null;
}

/** Product title/SKU/description — always driven by real loader data (the
 * PricingProfile's name/description, optionally enriched by a real Shopify product
 * lookup — see route.tsx). Never a literal product name baked into this component. */
export function ProductHeader({ title, sku, description }: ProductHeaderProps) {
  return (
    <div className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.sku}>SKU: {sku}</p>
      {description ? <p className={styles.description}>{description}</p> : null}
    </div>
  );
}
