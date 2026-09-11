import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>ImprintID Dynamic Pricing</h1>
        <p className={styles.text}>
          Configure product-specific pricing rules and let customers build a
          quote from real, server-calculated prices on the product page.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Configurable pricing profiles</strong>. Quantity breaks,
            decoration charges, option surcharges, and production rules per
            product.
          </li>
          <li>
            <strong>Live product-page quoting</strong>. Customers configure a
            product and see list and net pricing calculated on your server.
          </li>
          <li>
            <strong>Enforced at checkout</strong>. A Cart Transform verifies the
            signed price so the configured amount is the amount charged.
          </li>
        </ul>
      </div>
    </div>
  );
}
