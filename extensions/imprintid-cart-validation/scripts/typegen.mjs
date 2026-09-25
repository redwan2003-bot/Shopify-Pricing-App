#!/usr/bin/env node
/**
 * Replaces Shopify CLI's default typegen invocation (`pnpm exec graphql-code-generator`),
 * wired in via `build.typegen_command` in shopify.extension.toml.
 *
 * Root cause (verified 2026-09-25, see project notes): the pnpm-generated `graphql-code-generator`
 * CLI *binary* hits a dual-module-instance bug -- "Cannot use GraphQLNonNull ... from another
 * module or realm" -- reproduced with zero Shopify CLI involvement, using the exact same
 * dependency tree and the exact codegen.json Shopify CLI itself generates. Calling
 * @graphql-codegen/cli's own programmatic `generate()` API directly, in the same environment,
 * succeeds with no error. This script does exactly that, bypassing only the broken bin-shim path.
 *
 * Per the Shopify CLI 4.8.2 source (`vs()` in its Function-build implementation):
 * `build.typegen_command` is split on spaces and spawned directly (no shell, no package-manager
 * wrapper) with cwd = this extension's directory -- and, importantly, it receives no config path
 * at all; the codegen.json-generation step is skipped entirely for a custom typegen_command. So
 * this script reconstructs the exact same effective config Shopify CLI would otherwise write,
 * from this extension's own package.json "codegen" field, merged with Shopify's own default
 * scalar mapping for JS Functions (captured live from a real CLI-generated codegen.json).
 *
 * Identical to imprintid-cart-pricing's copy of this script -- both extensions have the same
 * "codegen" package.json shape and hit the same bin-shim bug.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));

// Shopify CLI normally invokes codegen through a `pnpm exec` that also ensures this directory's
// isolated dependencies are installed. This script is spawned directly instead, so it takes that
// responsibility itself rather than assuming some earlier step already did it.
if (!existsSync(join(extensionDir, "node_modules", "@graphql-codegen", "cli"))) {
  execFileSync("pnpm", ["install"], { cwd: extensionDir, stdio: "inherit" });
}

const pkg = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));
if (!pkg.codegen) throw new Error(`${extensionDir}/package.json has no "codegen" field`);

// Shopify CLI's own default scalar mapping for JS Functions (captured 2026-09-25 from a live
// CLI-generated codegen.json). Not re-derived dynamically: a custom typegen_command bypasses
// Shopify CLI's own config-generation step entirely, so nothing else supplies these.
const SHOPIFY_DEFAULT_CODEGEN_CONFIG = {
  defaultScalarType: "unknown",
  scalars: {
    Date: "string",
    DateTime: "string",
    DateTimeWithoutTimezone: "string",
    Decimal: "string",
    Handle: "string",
    ID: "string",
    JSON: "unknown",
    TimeWithoutTimezone: "string",
    URL: "string",
    Void: "null",
  },
};

const config = {
  ...pkg.codegen,
  config: {
    ...SHOPIFY_DEFAULT_CODEGEN_CONFIG,
    ...(pkg.codegen.config ?? {}),
    scalars: { ...SHOPIFY_DEFAULT_CODEGEN_CONFIG.scalars, ...(pkg.codegen.config?.scalars ?? {}) },
  },
};

process.chdir(extensionDir);
const { generate } = await import("@graphql-codegen/cli");
await generate(config, true);
