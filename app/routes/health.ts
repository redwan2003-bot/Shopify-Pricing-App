/** Lightweight public liveness probe for the deployed Cloudflare Worker. */
export async function loader(): Promise<Response> {
  return Response.json(
    {
      status: "ok",
      service: "shopify-pricing-app",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
