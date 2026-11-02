import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import prisma from "./db.server";
import { createScopedSessionStorage } from "./lib/db/session-storage.ts";
import { provisionShop } from "./lib/provisioning/provision-shop.ts";
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: createScopedSessionStorage(() => prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Per-shop setup on install (adjustment product, policy with enforcement OFF, Cart
    // Transform, Validation). Idempotent. A failure must not block the merchant from
    // opening the app, so it is logged and the home page offers "Finish setup".
    afterAuth: async ({ session, admin }) => {
      try {
        const report = await provisionShop(admin);
        if (report.ok) {
          if (report.changed.length) console.log(`[provision] ${session.shop}: set up ${report.changed.join(", ")}`);
        } else {
          console.error(`[provision] ${session.shop}: stopped at ${report.failedStep}: ${report.error}`);
        }
      } catch (error) {
        console.error(`[provision] ${session.shop}: unexpected error`, error);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
