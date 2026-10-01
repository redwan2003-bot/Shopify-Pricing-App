export type AdminNavigationItem = {
  label: string;
  href: string;
  feature?: "order_workflows";
};

const NAVIGATION: readonly AdminNavigationItem[] = [
  { label: "Home", href: "/app" },
  { label: "Product Configuration", href: "/app/product-configuration" },
  { label: "Pricing profiles", href: "/app/pricing-profiles" },
  { label: "Attachments", href: "/app/attachments" },
  { label: "Import pricing", href: "/app/pricing-import" },
  { label: "Catalog Management", href: "/app/catalog" },
  { label: "Inquiries", href: "/app/inquiries" },
  { label: "Order workflows", href: "/app/order-workflows", feature: "order_workflows" },
  { label: "Settings", href: "/app/settings" },
];

/**
 * Returns the admin navigation supported by this deployment. Released features
 * are always available; unreleased work is opt-in so a route cannot appear in
 * Shopify Admin before its database/storage prerequisites are deployed.
 */
export function getAdminNavigation(env: NodeJS.ProcessEnv = process.env): AdminNavigationItem[] {
  const orderWorkflowsEnabled = env.ENABLE_ORDER_WORKFLOWS === "true";
  return NAVIGATION.filter((item) => item.feature !== "order_workflows" || orderWorkflowsEnabled);
}
