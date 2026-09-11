/**
 * Task 5B.3B.2 — the IO layer for the phased provisioner: authenticated Admin GraphQL
 * (ImprintID app's own offline token, from the local Prisma DB — NEVER the Shopify
 * Claude Connector), local `.env` / Function-config file reconciliation, the git-ignored
 * recovery receipt, and the read-only state snapshot every phase consumes.
 *
 * NEVER prints the Admin token, the signing secret, or an authenticated URL — only
 * SHA-256 fingerprint prefixes (first 8 hex chars).
 */

import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADJ_PRODUCT_TITLE,
  API_VERSION,
  APP_NS,
  DEV_STORE,
  LNY01_PRODUCT_GID,
  PRODUCT_POLICY_KEY,
  RECEIPT_RELPATH,
  REQUIRED_SCOPES,
  SHOP_POLICY_KEY,
} from "./constants.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_PATH = REPO_ROOT + ".env";
const RECEIPT_PATH = REPO_ROOT + RECEIPT_RELPATH;
const SECRET_MODULES = [
  REPO_ROOT + "extensions/imprintid-cart-pricing/src/config.secret.generated.ts",
  REPO_ROOT + "extensions/imprintid-cart-validation/src/config.secret.generated.ts",
];

export const fp = (s) => (s && s.length ? createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8) : "0".repeat(8));

// ---------------------------------------------------------------------------
// Auth + Admin GraphQL
// ---------------------------------------------------------------------------

/** Loads the ImprintID app's own offline Admin session for the ONE dev store and
 * returns an authenticated `gql(query, variables)`. Throws (never returns) on a missing
 * session or a missing required scope. The token is never returned or logged. */
export async function connectAdmin() {
  const prisma = new PrismaClient();
  const session = await prisma.session.findUnique({
    where: { id: `offline_${DEV_STORE}` },
    select: { accessToken: true, scope: true, expires: true },
  });
  await prisma.$disconnect();

  if (!session || !session.accessToken) {
    throw new Error(`no offline Admin session for the ImprintID app on ${DEV_STORE} — open the app in Shopify admin to authorize.`);
  }
  const have = new Set((session.scope || "").split(",").map((s) => s.trim()).filter(Boolean));
  const missing = REQUIRED_SCOPES.filter((s) => !have.has(s));
  if (missing.length) {
    throw new Error(
      `the offline token is missing scopes: ${missing.join(", ")} (have: ${[...have].join(", ") || "none"}) — ` +
        "stop `npm run dev` with Ctrl+C, run it again, approve the scope update, then re-open the app in Shopify admin.",
    );
  }
  const token = session.accessToken;

  async function gql(query, variables = {}) {
    const res = await fetch(`https://${DEV_STORE}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new Error(`Admin API auth failed (${res.status}) — token stale; reauthorize.`);
    if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
    return body.data;
  }

  return { gql, sessionExpires: session.expires ?? null, scopes: [...have] };
}

export function userErrors(payload) {
  const e = payload?.userErrors || payload?.metafields?.userErrors || [];
  return Array.isArray(e) && e.length ? e : null;
}

// ---------------------------------------------------------------------------
// Read-only state snapshot
// ---------------------------------------------------------------------------

const STATE_QUERY = `
  query ImprintIdProvisionState($pid: ID!, $adjQuery: String!) {
    shop { id name currencyCode }
    currentAppInstallation { app { title apiKey } }
    shopPolicy: shop { metafield(namespace: "${APP_NS}", key: "${SHOP_POLICY_KEY}") { id jsonValue } }
    lny01: product(id: $pid) { id title status metafield(namespace: "${APP_NS}", key: "${PRODUCT_POLICY_KEY}") { id jsonValue } }
    shopDef: metafieldDefinitions(first: 5, namespace: "${APP_NS}", key: "${SHOP_POLICY_KEY}", ownerType: SHOP) { nodes { id } }
    prodDef: metafieldDefinitions(first: 5, namespace: "${APP_NS}", key: "${PRODUCT_POLICY_KEY}", ownerType: PRODUCT) { nodes { id } }
    shopifyFunctions(first: 50) { nodes { id title apiType app { title } } }
    cartTransforms(first: 25) { nodes { id functionId blockOnFailure } }
    validations(first: 25) { nodes { id title enabled blockOnFailure } }
    adj: products(first: 10, query: $adjQuery) {
      nodes {
        id title status onlineStoreUrl tags
        variants(first: 5) { nodes { id price inventoryPolicy taxable inventoryItem { tracked requiresShipping } } }
      }
    }
  }`;

/**
 * One authenticated round-trip → the plain snapshot every reconcile / plan / gate
 * function consumes. Also folds in the local receipt + local profile currency so the
 * pure layer stays IO-free. `profileCurrency` comes from the caller (Prisma).
 */
export async function readState(gql, { profileCurrency = null, receipt = null } = {}) {
  const data = await gql(STATE_QUERY, {
    pid: LNY01_PRODUCT_GID,
    adjQuery: `title:'${ADJ_PRODUCT_TITLE}'`,
  });

  const adjMatches = (data.adj?.nodes || []).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    onlineStoreUrl: p.onlineStoreUrl || null,
    tags: p.tags || [],
    variants: (p.variants?.nodes || []).map((v) => ({
      id: v.id,
      price: v.price,
      inventoryPolicy: v.inventoryPolicy,
      taxable: v.taxable,
      inventoryItem: { tracked: v.inventoryItem?.tracked ?? null, requiresShipping: v.inventoryItem?.requiresShipping ?? null },
    })),
  }));

  return {
    shopId: data.shop?.id ?? null,
    shopName: data.shop?.name ?? null,
    shopCurrency: data.shop?.currencyCode ?? null,
    app: {
      title: data.currentAppInstallation?.app?.title ?? null,
      apiKey: data.currentAppInstallation?.app?.apiKey ?? null,
    },
    profileCurrency,
    receipt,
    shopPolicyJson: data.shopPolicy?.metafield?.jsonValue ?? null,
    shopPolicyMetafieldId: data.shopPolicy?.metafield?.id ?? null,
    lny01: { id: data.lny01?.id ?? null, title: data.lny01?.title ?? null, status: data.lny01?.status ?? null },
    lny01PolicyJson: data.lny01?.metafield?.jsonValue ?? null,
    lny01PolicyMetafieldId: data.lny01?.metafield?.id ?? null,
    shopPolicyDefinitionId: data.shopDef?.nodes?.[0]?.id ?? null,
    productPolicyDefinitionId: data.prodDef?.nodes?.[0]?.id ?? null,
    functions: (data.shopifyFunctions?.nodes || []).map((f) => ({ id: f.id, title: f.title, apiType: f.apiType, app: f.app?.title ?? null })),
    cartTransforms: (data.cartTransforms?.nodes || []).map((t) => ({ id: t.id, functionId: t.functionId, blockOnFailure: t.blockOnFailure })),
    validations: (data.validations?.nodes || []).map((v) => ({ id: v.id, title: v.title, enabled: v.enabled, blockOnFailure: v.blockOnFailure })),
    adjustmentProductMatches: adjMatches,
  };
}

// ---------------------------------------------------------------------------
// Local signing-secret / .env / Function-config
// ---------------------------------------------------------------------------

function readEnv() {
  return existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
}
function envVar(env, key) {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1] : undefined;
}
function setEnvVar(env, key, value) {
  return new RegExp(`^${key}=`, "m").test(env)
    ? env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
}

/** Fingerprints of the three signing-secret sources — app-server (`.env`) and each
 * Function's generated config module. Values are NEVER returned, only 8-hex prefixes. */
export function readSecretFingerprints() {
  const appSecret = envVar(readEnv(), "IMPRINTID_CART_SIGNING_SECRET") || "";
  const fns = SECRET_MODULES.map((path) => {
    if (!existsSync(path)) return "";
    const m = readFileSync(path, "utf8").match(/CART_SIGNING_SECRET\s*=\s*"([^"]*)"/);
    return m ? m[1] : "";
  });
  return { appServer: fp(appSecret), transform: fp(fns[0]), validation: fp(fns[1]) };
}

/**
 * `--prepare` only: write `.env` with envelope v2, a signing secret (reused if one is
 * already present — idempotent), and the adjustment-variant GID. Returns the secret's
 * fingerprint. NEVER logs or returns the value.
 */
export function writeSigningEnv(adjustmentVariantGid) {
  let env = readEnv();
  let secret = envVar(env, "IMPRINTID_CART_SIGNING_SECRET");
  if (!secret || secret.trim().length === 0) secret = randomBytes(40).toString("base64url"); // 54 chars > 32 random bytes
  env = setEnvVar(env, "IMPRINTID_CART_ENVELOPE_VERSION", "2");
  env = setEnvVar(env, "IMPRINTID_CART_SIGNING_SECRET", secret);
  if (adjustmentVariantGid) env = setEnvVar(env, "IMPRINTID_ADJUSTMENT_VARIANT_ID", adjustmentVariantGid);
  writeFileSync(ENV_PATH, env, "utf8");
  return fp(secret);
}

// ---------------------------------------------------------------------------
// Recovery receipt (git-ignored, non-secret)
// ---------------------------------------------------------------------------

export function readReceipt() {
  if (!existsSync(RECEIPT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function receiptPath() {
  return RECEIPT_PATH;
}

/** Merge `patch` into the receipt and persist. Records a history entry whenever
 * `phaseReached` advances. NEVER stores the token or secret — only a fingerprint. */
export function writeReceipt(patch) {
  const prev = readReceipt() || {};
  const next = {
    schema: 1,
    scriptVersion: (patch && patch.scriptVersion) || prev.scriptVersion || "5B.3B.2",
    ...prev,
    ...patch,
    resources: { ...(prev.resources || {}), ...((patch && patch.resources) || {}) },
    policyState: { ...(prev.policyState || {}), ...((patch && patch.policyState) || {}) },
    currency: { ...(prev.currency || {}), ...((patch && patch.currency) || {}) },
    updatedAt: new Date().toISOString(),
  };
  const history = Array.isArray(prev.history) ? [...prev.history] : [];
  if (patch && patch.phaseReached && patch.phaseReached !== prev.phaseReached) {
    history.push({ phase: patch.phaseReached, at: next.updatedAt });
  }
  next.history = history;
  if ("secret" in next) delete next.secret;
  if ("accessToken" in next) delete next.accessToken;
  mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
  writeFileSync(RECEIPT_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}
