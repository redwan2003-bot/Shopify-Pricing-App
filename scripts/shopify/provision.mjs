#!/usr/bin/env node
/**
 * Task 5B.3B.2 — phased DEVELOPMENT-STORE provisioning for the ImprintID dynamic-pricing
 * pilot. Replaces the old one-step `.shopify/provision-5b3b.mjs --apply`.
 *
 *   node scripts/shopify/provision.mjs --check          # read-only report (default)
 *   node scripts/shopify/provision.mjs --prepare        # product/variant + .env + defs + policy values (enforcement OFF)
 *   node scripts/shopify/provision.mjs --activate       # ONE Cart Transform + ONE Validation (enforcement still OFF)
 *   node scripts/shopify/provision.mjs --enable-pilot   # flip enforcement_policy.enabled → true (LNY01 only; never universal)
 *   node scripts/shopify/provision.mjs --rollback-check # print an exact rollback plan; execute nothing
 *
 * Talks ONLY to the ImprintID app's own offline Admin session for
 * `imprintid-pricing-development.myshopify.com` (never the Shopify Claude Connector).
 * The store is hard-coded — a production store is unreachable. Never prints the Admin
 * token, the signing secret, or an authenticated URL.
 *
 * Ordering is strict: each phase does only its own step. `--activate` refuses to run
 * without prepared-state evidence AND matching signing-secret fingerprints across the
 * app server + both Functions. `--enable-pilot` refuses to run until both resources
 * read back correctly. See `scripts/shopify/README.md`.
 */

import { PrismaClient } from "@prisma/client";
import { MUTATION_LEASE_MINUTES, PHASES, PROFILE_REF, SCRIPT_VERSION } from "./constants.mjs";
import { leaseBlockers, sessionLeaseMinutes } from "./reconcile.mjs";
import {
  connectAdmin,
  readState,
  readReceipt,
  writeReceipt,
  receiptPath,
  readSecretFingerprints,
  writeSigningEnv,
  userErrors,
} from "./runtime.mjs";
import {
  parseShopEnforcementPolicy,
  parseProductPricingPolicy,
} from "../../app/lib/pricing-api/policy-metafields.ts";
import {
  phaseCheck,
  phasePrepare,
  phaseActivate,
  phaseEnablePilot,
  phaseRollbackCheck,
  StopError,
} from "./phases.mjs";

const log = (...a) => console.log(...a);

function selectedPhase(argv) {
  const flags = PHASES.map((p) => `--${p}`).filter((f) => argv.includes(f));
  if (flags.length > 1) throw new Error(`pick ONE phase, got: ${flags.join(", ")}`);
  return flags.length ? flags[0].slice(2) : "check";
}

async function profileCurrency() {
  const prisma = new PrismaClient();
  try {
    const p = await prisma.pricingProfile.findUnique({ where: { id: PROFILE_REF }, select: { currency: true } });
    return p?.currency ?? null;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const phase = selectedPhase(process.argv);
  const { gql, sessionExpires } = await connectAdmin();

  // MUTATION-PHASE SESSION LEASE GUARD. `--prepare` / `--activate` / `--enable-pilot`
  // refuse to start without at least MUTATION_LEASE_MINUTES of confirmed remaining
  // offline-session validity. `--check` / `--rollback-check` are read-only and exempt.
  const leaseFail = leaseBlockers(sessionExpires, phase);
  if (leaseFail.length) {
    throw new StopError(leaseFail.join("; "));
  }
  const leaseMin = sessionLeaseMinutes(sessionExpires);
  log(
    `session lease: ${leaseMin === null ? "unknown" : leaseMin.toFixed(1) + " min"} remaining` +
      `${MUTATION_LEASE_MINUTES && phase !== "check" && phase !== "rollback-check" ? ` (mutating phase needs ≥ ${MUTATION_LEASE_MINUTES})` : ""}` +
      ` — script version ${SCRIPT_VERSION}`,
  );

  const receipt = readReceipt();
  const state = await readState(gql, { profileCurrency: await profileCurrency(), receipt });

  // Belt-and-suspenders: refuse to operate against anything but the canonical dev app.
  if (!state.app.apiKey) throw new Error("could not read currentAppInstallation.app — aborting.");

  const io = {
    userErrors,
    readSecretFingerprints,
    writeSigningEnv,
    writeReceipt,
    readReceipt,
    receiptPath,
    parseShopEnforcementPolicy,
    parseProductPricingPolicy,
  };

  const ctx = { state, gql, io, log, sessionExpires };
  const runner = {
    check: phaseCheck,
    prepare: phasePrepare,
    activate: phaseActivate,
    "enable-pilot": phaseEnablePilot,
    "rollback-check": phaseRollbackCheck,
  }[phase];

  const result = await runner(ctx);

  if (result.mutated) log(`\n(receipt updated: ${receiptPath()})`);
  else if (phase === "check") log(`\n(no mutation, no secret generation, no receipt change)`);
}

main().catch((err) => {
  if (err instanceof StopError) {
    console.error(`\n✖ STOP: ${err.message}`);
    process.exit(1);
  }
  console.error(`\n✖ ERROR: ${err.message}`);
  process.exit(1);
});
