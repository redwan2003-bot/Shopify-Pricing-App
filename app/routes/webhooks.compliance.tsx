import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { handleComplianceWebhook } from "../lib/compliance/handle.ts";

/**
 * Shopify's mandatory privacy webhooks (customers/data_request, customers/redact,
 * shop/redact). `authenticate.webhook` verifies Shopify's HMAC signature and rejects
 * anything unsigned before this code runs. A failure returns 500 so Shopify retries.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    const result = await handleComplianceWebhook(prisma, { shop, topic, payload });
    console.log(`[compliance] ${topic} for ${shop}: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`[compliance] ${topic} for ${shop} failed:`, error);
    return new Response("compliance handler failed", { status: 500 });
  }
  return new Response(null, { status: 200 });
};
