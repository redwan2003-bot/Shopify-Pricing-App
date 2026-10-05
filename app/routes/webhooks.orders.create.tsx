import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { persistOrderWorkflow } from "../lib/orders/order-workflow.ts";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, session } = await authenticate.webhook(request);
  if (!session) return new Response();

  try {
    const result = await persistOrderWorkflow(prisma as unknown as Parameters<typeof persistOrderWorkflow>[0], shop, payload);
    if (!result.ok) {
      console.warn(`[orders/create] ${shop}: ${result.reason}`);
    } else {
      console.log(`[orders/create] ${shop}: persisted ${result.configurationCount} configuration(s), ${result.signedCount} signed`);
    }
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error(`[orders/create] ${shop} failed:`, error);
    return new Response("order workflow persistence failed", { status: 500 });
  }
};
