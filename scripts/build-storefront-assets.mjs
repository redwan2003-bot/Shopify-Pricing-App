import { build } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const assetsDir = path.join(repoRoot, "extensions", "imprintid-dynamic-pricing", "assets");

// Keep the storefront entry and quote validator in one versioned Shopify asset.
// An unversioned relative module can remain stale in a returning browser cache and
// reject a newer signed quote, leaving Add to Cart disabled.
await build({
  configFile: false,
  root: repoRoot,
  publicDir: false,
  logLevel: "warn",
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    outDir: assetsDir,
    lib: {
      entry: path.join(assetsDir, "dynamic-pricing.js"),
      formats: ["es"],
      fileName: () => "imprintid-dynamic-pricing-bundle.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
