import { renderToReadableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");

  // Automatically abort the React renderer after 6 seconds, which ensures
  // React has enough time to flush down the rejected boundary contents
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), streamTimeout + 1000);

  const body = await renderToReadableStream(
    <ServerRouter
      context={reactRouterContext}
      url={request.url}
    />,
    {
      signal: controller.signal,
      onError(error: unknown) {
        responseStatusCode = 500;
        console.error(error);
      },
    }
  );
  body.allReady.then(() => clearTimeout(timeoutId), () => clearTimeout(timeoutId));

  // Bots get the fully rendered document; browsers stream from the shell.
  if (isbot(userAgent ?? "")) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
