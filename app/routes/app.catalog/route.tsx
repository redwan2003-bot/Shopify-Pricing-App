import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { resolveStoreContext, CrossTenantError } from "../../lib/catalog/tenancy.ts";
import { readShopPolicyContext } from "../../lib/catalog/admin-client.ts";
import { checkEnforcementDisabled } from "../../lib/catalog/enforcement-guard.ts";
import {
  createResultFetcher,
  handleCatalogAdminAction,
  loadCatalogAdmin,
  type BulkJobView,
  type CatalogActionResult,
  type CatalogAdminData,
  type SyncJobView,
} from "../../lib/catalog/catalog-admin.ts";

import styles from "./styles.module.css";

interface LoaderData extends CatalogAdminData {
  shopDomain: string;
  shopCurrency: string | null;
  enforcementReadable: boolean;
  /** whether the SHOP has checkout enforcement switched on. "Enforcement-ready" products
   * are only actually enforced at checkout while this is true. */
  enforcementEnabled: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const store = await resolveStoreContext(prisma, session.shop, { createIfMissing: true });
  if (!store) throw new Response("Store not found", { status: 404 });

  const url = new URL(request.url);
  const [data, shopPolicy] = await Promise.all([
    loadCatalogAdmin(prisma, store, url.searchParams),
    readShopPolicyContext(admin),
  ]);

  const enforcementGate = shopPolicy.ok ? checkEnforcementDisabled(shopPolicy.enforcementPolicyJson) : null;

  return {
    ...data,
    shopDomain: store.shopDomain,
    shopCurrency: shopPolicy.ok ? shopPolicy.shopCurrency : store.shopCurrency,
    enforcementReadable: shopPolicy.ok,
    enforcementEnabled: !!enforcementGate && !enforcementGate.ok && enforcementGate.reason === "enabled",
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  let store;
  try {
    store = await resolveStoreContext(prisma, session.shop, { createIfMissing: true });
  } catch (error) {
    if (error instanceof CrossTenantError) {
      return Response.json({ ok: false, intent: "(auth)", code: "TENANCY", message: error.message }, { status: 400 });
    }
    throw error;
  }
  if (!store) return Response.json({ ok: false, intent: "(auth)", code: "NO_STORE", message: "store not found" }, { status: 404 });

  const [shopPolicy, form] = await Promise.all([readShopPolicyContext(admin), request.formData()]);

  // Actor identity comes ONLY from the authenticated session. The opaque staff-user id is
  // the whole of it — staff email is not collected or stored (see the schema note).
  const associated = (session as { onlineAccessInfo?: { associated_user?: { id?: number | string } } }).onlineAccessInfo?.associated_user;
  const rawUserId = associated?.id ?? (session as { userId?: unknown }).userId;
  const actor = { userId: rawUserId != null ? String(rawUserId) : null };

  const result = await handleCatalogAdminAction(
    { prisma, store, admin, actor, shopPolicy, fetchResult: createResultFetcher() },
    form,
  );
  return Response.json(result, { status: result.ok ? 200 : 409 });
};

// ---------------------------------------------------------------------------

export default function CatalogManagement() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();

  // One fetcher per long-running workflow, so each can drive its own request loop
  // without blocking the page or the others.
  const sync = useStepFetcher();
  const assign = useStepFetcher();
  const rollback = useStepFetcher();
  const plan = useStepFetcher();

  const busy = navigation.state !== "idle";
  const activeProfiles = useMemo(() => data.profiles.filter((p) => p.isActive), [data.profiles]);

  // Refresh the durable job state whenever a step reports it finished a unit of work.
  const anyRunning = sync.running || assign.running || rollback.running;
  useEffect(() => {
    if (!anyRunning && revalidator.state === "idle") revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyRunning]);

  const filterFields: Array<[string, string | undefined]> = [
    ["text", data.filter.text],
    ["productId", data.filter.productId],
    ["sku", data.filter.sku],
    ["skuMatch", data.filter.skuMatch],
    ["coverageStatus", data.filter.coverageStatus],
    ["pricingProfileId", data.filter.pricingProfileId],
    ["shopifyStatus", data.filter.shopifyStatus],
    ["vendor", data.filter.vendor],
    ["productType", data.filter.productType],
    ["tag", data.filter.tag],
  ];
  const selectionDescriptor = JSON.stringify({
    kind: "filter",
    filter: Object.fromEntries(filterFields.filter(([, v]) => v != null && v !== "")),
  });
  // `skuMatch` is only a match modifier — it never narrows on its own, so it doesn't
  // count. No narrowing field set ⇒ a bulk assign here would touch the entire catalog.
  const NARROWING_KEYS = new Set(["text", "productId", "sku", "coverageStatus", "pricingProfileId", "shopifyStatus", "vendor", "productType", "tag"]);
  const wholeCatalog = !filterFields.some(([k, v]) => NARROWING_KEYS.has(k) && v != null && v !== "");

  const c = data.coverage;
  const bulkActive = !!data.activeBulkJobId || assign.running || rollback.running;
  const dryRunData = plan.result?.ok && plan.result.intent === "dryRun" ? plan.result.data : undefined;

  // A whole-catalog dry run must be explicitly acknowledged; the checkbox resets whenever
  // the filter (and therefore the selection) changes.
  const [wholeCatalogAck, setWholeCatalogAck] = useState(false);
  useEffect(() => setWholeCatalogAck(false), [selectionDescriptor]);

  return (
    <s-page heading="Catalog Management">
      {!data.enforcementReadable ? (
        <s-section>
          <p className={styles.alert} role="alert">
            The shop&apos;s enforcement policy could not be read, so assignment and rollback are unavailable right now.
            Reload the page; if this persists, reconnect the app.
          </p>
        </s-section>
      ) : null}

      {/* ------------------------------------------------ coverage + sync */}
      <s-section heading="Coverage">
        <dl className={styles.metrics}>
          <Metric label="Products synced" value={c.totalProducts} />
          <Metric label="Variants" value={data.variantCount} />
          <Metric label="Assigned" value={c.assigned} />
          <Metric label="Unassigned" value={c.unassigned} />
          <Metric label="Invalid" value={c.invalid} />
          <Metric label="Inactive profile" value={c.inactiveProfileAssignments} />
          <Metric label="Policy &amp; override ready" value={c.enforcementReady} />
          <Metric label="Removed in Shopify" value={c.removedFromShopify} />
        </dl>
        <p role="status" className={styles.notice}>
          {data.enforcementEnabled ? (
            <>Checkout enforcement is <strong>ON</strong>. The {c.enforcementReady} ready product(s) are being priced by the app at checkout.</>
          ) : (
            <>
              Checkout enforcement is <strong>OFF</strong>. &ldquo;Policy &amp; override ready&rdquo; means the pricing
              profile and app-owned policy are in place — those products are still priced normally at checkout until the
              shop&apos;s enforcement policy is enabled.
            </>
          )}
        </p>
        <p>
          Last successful sync: {c.lastSuccessfulSyncAt ? new Date(c.lastSuccessfulSyncAt).toLocaleString() : "never"}.
          {" "}Shop currency: {data.shopCurrency ?? "unknown"}.
        </p>

        <SyncPanel data={data} sync={sync} busy={busy} disabled={!!data.activeBulkJobId} />
      </s-section>

      {/* --------------------------------------------------- product list */}
      <s-section heading="Products">
        <Form method="get" role="search" aria-label="Catalog filters" className={styles.filters}>
          <Field label="Title or handle" name="text" defaultValue={data.filter.text} />
          <Field label="Product ID" name="productId" defaultValue={data.filter.productId} />
          <Field label="Variant SKU" name="sku" defaultValue={data.filter.sku} />
          <SelectField
            label="SKU match" name="skuMatch" defaultValue={data.filter.skuMatch ?? "exact"}
            options={[["exact", "Exact"], ["contains", "Contains"]]}
          />
          <SelectField
            label="Assignment" name="coverageStatus" defaultValue={data.filter.coverageStatus}
            options={[["", "Any"], ["unassigned", "Unassigned"], ["assigned", "Assigned"], ["inactive_profile", "Inactive profile"], ["invalid", "Invalid"]]}
          />
          <SelectField
            label="Pricing profile" name="pricingProfileId" defaultValue={data.filter.pricingProfileId}
            options={[["", "Any"], ...data.profiles.map((p) => [p.id, p.isActive ? p.name : `${p.name} (inactive)`] as [string, string])]}
          />
          <SelectField
            label="Shopify status" name="shopifyStatus" defaultValue={data.filter.shopifyStatus}
            options={[["", "Any"], ["ACTIVE", "Active"], ["ARCHIVED", "Archived"], ["DRAFT", "Draft"]]}
          />
          <SelectField
            label="Vendor" name="vendor" defaultValue={data.filter.vendor}
            options={[["", "Any"], ...data.facets.vendors.map((v) => [v, v] as [string, string])]}
          />
          <SelectField
            label="Product type" name="productType" defaultValue={data.filter.productType}
            options={[["", "Any"], ...data.facets.productTypes.map((v) => [v, v] as [string, string])]}
          />
          <Field label="Tag" name="tag" defaultValue={data.filter.tag} />
          <button type="submit" disabled={busy}>Filter</button>
        </Form>

        <table className={styles.table}>
          <caption>{data.page.items.length} product(s) on this page (page size {data.page.pageSize})</caption>
          <thead>
            <tr><Th>Title</Th><Th>Product ID</Th><Th>Variants</Th><Th>Status</Th><Th>Assignment</Th><Th>Profile</Th><Th>Policy ready</Th></tr>
          </thead>
          <tbody>
            {data.page.items.length === 0 ? (
              <tr><td colSpan={7}>No products match these filters.</td></tr>
            ) : (
              data.page.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.title || "(untitled)"}</td>
                  <td><code>{p.shopifyProductId}</code></td>
                  <td>{p.variantCount}</td>
                  <td>{p.status}{p.removedFromShopifyAt ? " · removed" : ""}</td>
                  <td>{p.coverageStatus}</td>
                  <td>{p.assignedProfileName ?? "—"}</td>
                  <td>{p.enforcementReady ? "yes" : "no"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination nextCursor={data.page.nextCursor} searchParams={searchParams} />
      </s-section>

      {/* ------------------------------------------------- bulk assignment */}
      <s-section heading="Bulk assign a pricing profile">
        <p>
          Every assignment starts with a dry run. Review the counts, confirm, then process the job in
          batches — you can leave and come back; progress is saved.
        </p>
        {bulkActive ? (
          <p className={styles.notice} role="status">
            A job is currently active. Finish or resume it before starting another assignment.
          </p>
        ) : null}

        <plan.Fetcher.Form method="post" className={styles.stack}>
          <input type="hidden" name="intent" value="dryRun" />
          <input type="hidden" name="selection" value={selectionDescriptor} />
          <input type="hidden" name="idempotencyKey" value={`dry-${selectionDescriptor.length}-${new Date().toISOString().slice(0, 16)}`} />
          <label>
            Pricing profile
            <select name="pricingProfileId" required disabled={bulkActive}>
              <option value="">Select…</option>
              {activeProfiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>)}
            </select>
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" name="replaceExisting" value="1" disabled={bulkActive} /> Replace existing assignments
          </label>
          {wholeCatalog ? (
            <div className={styles.alert} role="alert">
              <strong>No filters are set.</strong> This targets <strong>every one of the {c.totalProducts} product(s)</strong> in
              the catalog. Add a filter under &ldquo;Products&rdquo; above to assign fewer.
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  name="acknowledgeWholeCatalog"
                  value="1"
                  checked={wholeCatalogAck}
                  disabled={bulkActive}
                  onChange={(e) => setWholeCatalogAck(e.currentTarget.checked)}
                />{" "}
                Yes, assign this profile across the entire catalog
              </label>
            </div>
          ) : (
            <p>Target: every product matching the filters above.</p>
          )}
          <button
            type="submit"
            disabled={busy || bulkActive || !data.enforcementReadable || (wholeCatalog && !wholeCatalogAck)}
          >
            Run dry run
          </button>
        </plan.Fetcher.Form>

        {dryRunData ? <DryRunPanel data={dryRunData} busy={busy} disabled={bulkActive} /> : null}
        <StepMessage step={plan} />
      </s-section>

      {/* ------------------------------------------------------------ jobs */}
      <s-section heading="Jobs">
        <SyncJobTable jobs={data.syncJobs} />
        <BulkJobTable
          jobs={data.bulkJobs}
          profiles={data.profiles}
          busy={busy}
          assign={assign}
          rollback={rollback}
          enforcementReadable={data.enforcementReadable}
        />
        <StepMessage step={assign} />
        <StepMessage step={rollback} />
      </s-section>

      <s-section heading="Sync activity" slot="aside">
        <SyncActivity jobs={data.syncJobs} step={sync} />
      </s-section>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// A fetcher that drives a multi-request workflow: it re-submits while the server keeps
// answering `more: true`, so one click completes a whole bounded, resumable operation
// without any detached server-side work.
//
// Task 6A.4B.1 — two corrections after a real sync got stuck reporting "CREATED" forever
// (377 client-side steps, zero further server writes):
//   1. THE BUG: continuation blindly resubmitted the SAME `intent` it started with. For
//      "Synchronize catalog from Shopify" that intent is `sync.start` — whose IDEMPOTENT
//      replay (same idempotencyKey) just echoes back the stale row without ever polling
//      Shopify again. Every response now names `continueIntent` — the intent the NEXT
//      step must use — so the loop switches from `sync.start` to `sync.advance` itself
//      instead of hammering an idempotent no-op forever.
//   2. UNTHROTTLED POLLING: there was no delay at all between an idle response and the
//      next submit. A response may carry `retryAfterMs` (only while genuinely waiting on
//      Shopify with nothing to ingest — see `computeBulkPollBackoffMs`); the loop now
//      waits that long via ONE scheduled timer (guarded so a re-render can never schedule
//      a second one) before resubmitting, and never fires while a request is in flight.
// ---------------------------------------------------------------------------

interface StepFetcher {
  Fetcher: ReturnType<typeof useFetcher<CatalogActionResult>>;
  result: CatalogActionResult | undefined;
  running: boolean;
  steps: number;
  start: (fields: Record<string, string>) => void;
  stop: () => void;
}

const MAX_STEPS = 500;
/** Even with no server-provided `retryAfterMs`, never resubmit with zero delay. */
const MIN_STEP_DELAY_MS = 250;
/** However long the server asks us to wait, never longer than this. */
const MAX_STEP_DELAY_MS = 30_000;

function useStepFetcher(): StepFetcher {
  const fetcher = useFetcher<CatalogActionResult>();
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState(0);
  const fieldsRef = useRef<Record<string, string> | null>(null);
  const stepsRef = useRef(0);
  // Guards "one in-flight request": a pending scheduled resubmit, so a duplicate effect
  // firing (e.g. React's dev-mode double-invoke) can never queue a second one.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Continue the loop whenever a step settles and the server asked for another.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (timerRef.current !== null) return; // a resubmit is already scheduled
    const data = fetcher.data;
    const shouldContinue = data.ok && data.more && fieldsRef.current && stepsRef.current < MAX_STEPS;
    if (!shouldContinue) {
      if (running) setRunning(false);
      fieldsRef.current = null;
      return;
    }
    const payload = (data.data ?? {}) as Record<string, unknown>;
    // Carry forward ids the server minted on the first step (e.g. the sync job id), and
    // switch intent to whatever the server named as the correct continuation.
    const next = { ...fieldsRef.current! };
    if (typeof payload.syncJobId === "string") next.syncJobId = payload.syncJobId;
    if (typeof payload.rollbackJobId === "string") next.jobId = payload.rollbackJobId;
    if (typeof payload.continueIntent === "string") next.intent = payload.continueIntent;
    fieldsRef.current = next;

    const serverDelay = typeof payload.retryAfterMs === "number" && payload.retryAfterMs > 0 ? payload.retryAfterMs : 0;
    const delay = Math.min(MAX_STEP_DELAY_MS, Math.max(MIN_STEP_DELAY_MS, serverDelay));

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      stepsRef.current += 1;
      setSteps(stepsRef.current);
      fetcher.submit(next, { method: "POST" });
    }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Cancel a pending resubmit if the component unmounts mid-wait.
  useEffect(() => clearTimer, []);

  return {
    Fetcher: fetcher,
    result: fetcher.data,
    running: running || fetcher.state !== "idle" || timerRef.current !== null,
    steps,
    start(fields) {
      clearTimer();
      stepsRef.current = 0;
      setSteps(0);
      fieldsRef.current = fields;
      setRunning(true);
      fetcher.submit(fields, { method: "POST" });
    },
    stop() {
      clearTimer();
      fieldsRef.current = null;
      setRunning(false);
    },
  };
}

function StepMessage({ step }: { step: StepFetcher }) {
  const r = step.result;
  if (!r) return null;
  return (
    <p className={r.ok ? styles.notice : styles.alert} role={r.ok ? "status" : "alert"}>
      {r.ok ? r.message : `${r.message}`}
      {step.running ? " (working…)" : null}
      {!r.ok && r.blockingErrors?.length ? (
        <span className={styles.detail}>{r.blockingErrors.join(" · ")}</span>
      ) : null}
    </p>
  );
}

// ---------------------------------------------------------------------------

function SyncPanel({
  data, sync, busy, disabled,
}: { data: LoaderData; sync: StepFetcher; busy: boolean; disabled: boolean }) {
  const activeId = data.activeSyncJobId;
  return (
    <div className={styles.stack}>
      {activeId ? (
        <>
          <p role="status">
            A synchronization is in progress. It resumes from where it left off — you can leave this page.
          </p>
          <button
            type="button"
            disabled={busy || sync.running}
            onClick={() => sync.start({ intent: "sync.advance", syncJobId: activeId })}
          >
            {sync.running ? `Continuing… (step ${sync.steps})` : "Continue synchronization"}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy || sync.running || disabled}
          onClick={() =>
            sync.start({ intent: "sync.start", idempotencyKey: `sync-${new Date().toISOString().slice(0, 16)}` })
          }
          title={disabled ? "Finish the active assignment job first" : undefined}
        >
          {sync.running ? `Synchronizing… (step ${sync.steps})` : "Synchronize catalog from Shopify"}
        </button>
      )}
      <StepMessage step={sync} />
    </div>
  );
}

function SyncActivity({ jobs, step }: { jobs: SyncJobView[]; step: StepFetcher }) {
  const latest = jobs[0];
  if (!latest) return <p>No synchronization has run yet.</p>;
  return (
    <dl className={styles.definitions}>
      <dt>Status</dt><dd>{latest.status}{latest.bulkOperationStatus ? ` · Shopify ${latest.bulkOperationStatus}` : ""}</dd>
      <dt>Lines read</dt><dd>{latest.objectsSeen}</dd>
      <dt>Products</dt><dd>{latest.productsUpserted}{latest.productsRemoved ? ` (${latest.productsRemoved} removed)` : ""}</dd>
      <dt>Variants</dt><dd>{latest.variantsUpserted}{latest.variantsRemoved ? ` (${latest.variantsRemoved} removed)` : ""}</dd>
      {step.running ? <><dt>Request</dt><dd>step {step.steps}</dd></> : null}
      {latest.errorCode ? <><dt>Error</dt><dd>{latest.errorMessage ?? latest.errorCode}</dd></> : null}
    </dl>
  );
}

/** Above this many planned Shopify writes, "Confirm & create job" needs an explicit
 * "I've reviewed these numbers" tick — one bounded batch is 25. */
const APPLY_REVIEW_THRESHOLD = 25;

function DryRunPanel({ data, busy, disabled }: { data: Record<string, unknown>; busy: boolean; disabled: boolean }) {
  const counts = data.counts as Record<string, number>;
  const profile = data.profile as { name: string; currency: string; revision: number } | undefined;
  const blockingErrors = (data.blockingErrors as string[] | undefined) ?? [];
  const replaceExisting = data.replaceExisting === true;
  const wholeCatalog = data.wholeCatalog === true;
  const writes = counts.estimatedOperations ?? 0;
  const needsReviewAck = writes >= APPLY_REVIEW_THRESHOLD;
  const [reviewAck, setReviewAck] = useState(false);
  const confirmText =
    `Create a job that writes ${writes} product pricing assignment(s)` +
    (profile ? ` for "${profile.name}"` : "") +
    (replaceExisting ? ", REPLACING any existing assignment" : "") +
    (wholeCatalog ? ", across the ENTIRE catalog" : "") +
    "?";
  return (
    <div className={styles.panel}>
      <h3>Dry run</h3>
      {profile ? <p>Profile: {profile.name} ({profile.currency}), revision {profile.revision}</p> : null}
      <ul className={styles.counts}>
        <li>Matched: {counts.totalMatched}</li>
        <li>Eligible: {counts.eligible}</li>
        <li>Already correct: {counts.unchanged}</li>
        <li>Needs verification (re-checked against Shopify, usually no write): {counts.verificationRequired ?? 0}</li>
        <li>Assigned elsewhere: {counts.alreadyAssigned}</li>
        <li>Will be replaced: {counts.replacementRequired}</li>
        <li>Invalid: {counts.invalid}</li>
        <li>Skipped: {counts.skipped}</li>
        <li><strong>Shopify writes: {counts.estimatedOperations}</strong></li>
      </ul>
      <p>Valid until {new Date(String(data.expiresAt)).toLocaleString()}.</p>
      {blockingErrors.length ? (
        <div role="alert" className={styles.alert}>
          <strong>Cannot apply:</strong>
          <ul>{blockingErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      ) : (
        <Form
          method="post"
          onSubmit={(e) => {
            if (!window.confirm(confirmText)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="apply" />
          <input type="hidden" name="jobId" value={String(data.jobId)} />
          <input type="hidden" name="dryRunFingerprint" value={String(data.dryRunFingerprint)} />
          {needsReviewAck ? (
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={reviewAck}
                disabled={disabled}
                onChange={(e) => setReviewAck(e.currentTarget.checked)}
              />{" "}
              I&apos;ve reviewed the {writes} planned write(s){replaceExisting ? " and the replacement" : ""} above
            </label>
          ) : null}
          <button type="submit" disabled={busy || disabled || (needsReviewAck && !reviewAck)}>
            Confirm &amp; create job
          </button>
        </Form>
      )}
    </div>
  );
}

function SyncJobTable({ jobs }: { jobs: SyncJobView[] }) {
  if (jobs.length === 0) return <p>No synchronization jobs yet.</p>;
  return (
    <table className={styles.table}>
      <caption>Catalog synchronization</caption>
      <thead><tr><Th>Status</Th><Th>Products</Th><Th>Variants</Th><Th>Finished</Th><Th>Error</Th></tr></thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <td>{j.status}{j.bulkOperationStatus ? ` · ${j.bulkOperationStatus}` : ""}</td>
            <td>{j.productsUpserted}{j.productsRemoved ? ` (−${j.productsRemoved})` : ""}</td>
            <td>{j.variantsUpserted}{j.variantsRemoved ? ` (−${j.variantsRemoved})` : ""}</td>
            <td>{j.finishedAt ? new Date(j.finishedAt).toLocaleString() : "—"}</td>
            <td>{j.errorMessage ?? j.errorCode ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BulkJobTable({
  jobs, profiles, busy, assign, rollback, enforcementReadable,
}: {
  jobs: BulkJobView[];
  profiles: CatalogAdminData["profiles"];
  busy: boolean;
  assign: StepFetcher;
  rollback: StepFetcher;
  enforcementReadable: boolean;
}) {
  if (jobs.length === 0) return <p>No assignment jobs yet.</p>;
  const profileName = (id: string | null) => profiles.find((p) => p.id === id)?.name ?? "—";
  const anyRunning = assign.running || rollback.running;

  return (
    <table className={styles.table}>
      <caption>Assignment and rollback jobs</caption>
      <thead>
        <tr><Th>Type</Th><Th>Status</Th><Th>Profile</Th><Th>Progress</Th><Th>Actions</Th></tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const step = j.jobType === "rollback" ? rollback : assign;
          const canProcess = ["queued", "running", "paused"].includes(j.status) && !j.leaseHeld;
          return (
            <tr key={j.id}>
              <td>{j.jobType}{j.rollbackOfJobId ? " ↩" : ""}</td>
              <td>
                {j.status}
                {j.leaseHeld ? " · in progress" : ""}
                {j.errorMessage ? <span className={styles.detail}>{j.errorMessage}</span> : null}
              </td>
              <td>{profileName(j.pricingProfileId)}</td>
              <td>
                {j.jobType === "rollback" ? (
                  <>
                    {j.succeeded} restored · {j.unchanged} unchanged (no write) ·{" "}
                    {j.failed} failed{j.conflicts ? ` (${j.conflicts} conflict${j.conflicts === 1 ? "" : "s"})` : ""} / {j.totalItems}
                  </>
                ) : (
                  <>
                    {j.succeeded} written · {j.unchanged} already correct · {j.skipped} skipped ·{" "}
                    {j.failed} failed{j.conflicts ? ` (${j.conflicts} conflict${j.conflicts === 1 ? "" : "s"})` : ""} / {j.totalItems}
                  </>
                )}
              </td>
              <td className={styles.actions}>
                {canProcess ? (
                  <button
                    type="button"
                    disabled={busy || anyRunning || !enforcementReadable}
                    onClick={() =>
                      step.start({ intent: j.jobType === "rollback" ? "rollback.process" : "job.process", jobId: j.id })
                    }
                  >
                    {step.running ? `Working… (${step.steps})` : j.status === "queued" ? "Start processing" : "Continue"}
                  </button>
                ) : null}
                {j.retryableFailed > 0 ? (
                  <JobButton intent="job.retry" jobId={j.id} label={`Retry ${j.retryableFailed} failed`} busy={busy || anyRunning} />
                ) : null}
                {["running", "paused"].includes(j.status) && !j.leaseHeld ? (
                  <JobButton intent="job.resume" jobId={j.id} label="Resume" busy={busy || anyRunning} />
                ) : null}
                {j.jobType === "assign" && !j.hasRollback && ["completed", "partial", "failed"].includes(j.status) ? (
                  <JobButton
                    intent="rollback.plan" jobId={j.id} label="Plan rollback" busy={busy || anyRunning}
                    confirm="Create a rollback plan for this job? Nothing is restored until you process it."
                  />
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function JobButton({
  intent, jobId, label, busy, confirm: confirmMsg,
}: { intent: string; jobId: string; label: string; busy: boolean; confirm?: string }) {
  return (
    <Form
      method="post"
      onSubmit={(e) => {
        if (confirmMsg && !window.confirm(confirmMsg)) e.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="jobId" value={jobId} />
      <button type="submit" disabled={busy}>{label}</button>
    </Form>
  );
}

// ---------------------------------------------------------------------------

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.metric}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Field({ label, name, defaultValue }: { label: string; name: string; defaultValue?: string }) {
  return (
    <label className={styles.field}>
      {label}
      <input type="text" name={name} defaultValue={defaultValue ?? ""} />
    </label>
  );
}

function SelectField({
  label, name, defaultValue, options,
}: { label: string; name: string; defaultValue?: string; options: Array<[string, string]> }) {
  return (
    <label className={styles.field}>
      {label}
      <select name={name} defaultValue={defaultValue ?? ""}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col">{children}</th>;
}

function Pagination({ nextCursor, searchParams }: { nextCursor: string | null; searchParams: URLSearchParams }) {
  if (!nextCursor) return <p>End of results.</p>;
  const next = new URLSearchParams(searchParams);
  next.set("cursor", nextCursor);
  return <p><a href={`?${next.toString()}`}>Next page →</a></p>;
}

export function ErrorBoundary() {
  return (
    <s-page heading="Catalog Management">
      <s-section>
        <p role="alert">Something went wrong loading catalog management. Reload the page to try again.</p>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
