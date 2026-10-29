import { createRequestHandler } from "react-router";
import { runInRequestScope } from "../app/db.server";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch(request, env, ctx) {
    // Each request gets its own database client, released once the response has finished.
    return runInRequestScope(
      env.DATABASE_URL,
      () =>
        requestHandler(request, {
          cloudflare: { env, ctx },
        }),
      ctx,
    );
  },
} satisfies ExportedHandler<Env>;
