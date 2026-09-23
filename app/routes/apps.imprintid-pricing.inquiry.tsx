import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createInquiry } from "../lib/inquiries/create.ts";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * PUBLIC App Proxy endpoint for the storefront block's "Request Info" / "Request Quote"
 * forms (`POST /apps/imprintid-pricing/inquiry`). `authenticate.public.appProxy` has already
 * verified Shopify's signature and resolved the trusted shop; nothing from the request body
 * decides which shop an inquiry belongs to.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." } }, 405);
  }
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return json({ ok: false, error: { code: "SHOP_NOT_AVAILABLE", message: "This shop is not available." } }, 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: "INVALID_INQUIRY", message: "The request could not be read." } }, 400);
  }

  try {
    const result = await createInquiry(prisma, session.shop, body);
    if (!result.ok) {
      return json({ ok: false, error: { code: result.code, message: result.message } }, result.status);
    }
    return json({ ok: true }, 200);
  } catch (error) {
    console.error("[inquiry] failed to store inquiry:", error);
    return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "We could not save your message. Please try again." } }, 500);
  }
};
