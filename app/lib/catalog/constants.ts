/**
 * Task 6A — universal catalog management + bulk pricing-profile assignment.
 * Central bounds. Nothing here scales with catalog size; every list operation is
 * cursor-paged or batch-processed against these limits.
 */

/** Max products a single Admin/UI page ever renders or the browser ever submits by id.
 * "All filtered" / "all products" selections are a server-side descriptor instead. */
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** An explicit-id selection is capped at this — beyond it callers must use a filter
 * descriptor. Keeps a request body bounded regardless of catalog size. */
export const SELECTION_INLINE_MAX = 250;

/** Bulk-assignment worker: products processed per persisted batch. Exactly Shopify's
 * `metafieldsSet` cap, so one batch is one read round-trip and one write round-trip. */
export const ASSIGN_BATCH_SIZE = 25;

/** Task 6A.1 — how many bulk-result JSONL lines ONE bounded Admin request may ingest
 * before checkpointing and returning. Keeps a synchronization request short enough to
 * complete well inside a normal request budget while still making steady progress. */
export const SYNC_OBJECTS_PER_REQUEST = 2_000;

/** Task 6A.1 — how many `ASSIGN_BATCH_SIZE` batches ONE bounded Admin request may
 * process before returning so the browser can render progress and re-poll. */
export const ASSIGN_BATCHES_PER_REQUEST = 8;

/** A claimed item older than this (worker crashed mid-batch) may be re-claimed. */
export const ITEM_CLAIM_STALE_MS = 5 * 60 * 1000;

/** Retry policy for throttling / transient Shopify errors. Permanent validation
 * failures are never retried. */
export const MAX_ITEM_ATTEMPTS = 5;
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 60_000;

/** Dry-run evidence lifetime. Apply after this must re-run the dry run. */
export const DRY_RUN_TTL_MS = 30 * 60 * 1000;

/** JSONL streaming parser: max bytes buffered before a line is forced (guards against a
 * pathological unterminated line). Real Shopify bulk-result lines are a few hundred bytes. */
export const JSONL_MAX_LINE_BYTES = 64 * 1024;

/** Coverage reconciliation batch size. */
export const RECONCILE_BATCH_SIZE = 500;

/** The app-owned product metafield the Cart Transform / Validation Functions read. */
export const PRICING_POLICY_NAMESPACE = "$app:imprintid";
export const PRICING_POLICY_KEY = "pricing_policy";
export const ENFORCEMENT_POLICY_KEY = "enforcement_policy";

/** Policy metafield schema version (mirrors `policy-metafields.ts#POLICY_SCHEMA_VERSION`). */
export const POLICY_SCHEMA_VERSION = 1;
