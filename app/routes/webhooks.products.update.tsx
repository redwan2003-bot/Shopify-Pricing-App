import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { handleProductWebhookEvent } from "../lib/catalog/webhook-sync.ts";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload, session } = await authenticate.webhook(request);
  if (!session) return new Response();

  const result = await handleProductWebhookEvent(prisma, { shop, topic, webhookId, payload });
  console.log(`[webhooks] ${topic} for ${shop}: ${result.status}`);
  return new Response();
};
