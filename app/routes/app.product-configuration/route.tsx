import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { loadPricingCatalog } from "../../lib/pricing-api/catalog.ts";
import { handlePricingApiRequest } from "../../lib/pricing-api/handler.ts";
import { PricingError } from "../../lib/pricing/index.ts";
import type { PricingCatalog } from "../../lib/pricing-api/catalog.ts";
import type { ApiResponseBody } from "../../lib/pricing-api/types.ts";
import type { PricingCalculationOutcome, ProductConfigurationState } from "../../lib/product-configuration/types.ts";
import {
  buildCalculationFingerprint,
  buildCalculationRequestBody,
  buildDefaultConfigurationState,
  buildQuoteSummary,
  buildSelectedConfigurationRows,
  productConfigurationShouldRevalidate,
  selectAttachmentGroups,
  selectFeatureGroups,
  selectGenericGroups,
  shouldSubmitCalculation,
} from "../../lib/product-configuration/view-model.ts";

import { ProductHeader } from "./components/ProductHeader.tsx";
import { ProductMedia } from "./components/ProductMedia.tsx";
import type { ProductMediaImage } from "./components/ProductMedia.tsx";
import { QuantitySelector } from "./components/QuantitySelector.tsx";
import { DecorationMethodSelector } from "./components/DecorationMethodSelector.tsx";
import { ImprintLocationSelector } from "./components/ImprintLocationSelector.tsx";
import { ColorCountSelector } from "./components/ColorCountSelector.tsx";
import { DecorationOptionsToggles } from "./components/DecorationOptionsToggles.tsx";
import { ProductColorSelector } from "./components/ProductColorSelector.tsx";
import { OptionGroupSelector } from "./components/OptionGroupSelector.tsx";
import { AttachmentsSection } from "./components/AttachmentsSection.tsx";
import { ProductionSelector } from "./components/ProductionSelector.tsx";
import { PricingSummary } from "./components/PricingSummary.tsx";
import { ActionButtons } from "./components/ActionButtons.tsx";
import { QuoteRequestModal } from "./components/QuoteRequestModal.tsx";

import styles from "./styles.module.css";

const DEFAULT_PREVIEW_SKU = "LNY01";
const RECALCULATE_DEBOUNCE_MS = 350;

interface LoaderData {
  sku: string;
  catalog: PricingCatalog | null;
  catalogError: { code: string; message: string } | null;
  product: { title: string | null; description: string | null; images: ProductMediaImage[] } | null;
}

/**
 * Loads the real pricing catalog for the previewed SKU (`loadPricingCatalog` — the same
 * read-only projection the storefront's `GET /apps/imprintid-pricing/pricing` route
 * uses) plus a best-effort Shopify product lookup for media/title enrichment. No mock
 * pricing data is used anywhere in this loader: if the catalog can't be loaded, that
 * failure is surfaced to the page as `catalogError`, not papered over with placeholder
 * numbers.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const sku = url.searchParams.get("sku")?.trim() || DEFAULT_PREVIEW_SKU;

  let catalog: PricingCatalog | null = null;
  let catalogError: { code: string; message: string } | null = null;
  try {
    catalog = await loadPricingCatalog(prisma, session.shop, sku);
  } catch (error) {
    if (error instanceof PricingError) {
      catalogError = { code: error.code, message: error.message };
    } else {
      console.error("[app.product-configuration] catalog load failed:", error);
      catalogError = { code: "INTERNAL_ERROR", message: "An unexpected error occurred while loading this product." };
    }
  }

  // Best-effort only: LNY01 (and most seeded pricing profiles today) has no linked
  // Shopify product yet — see prisma/seed-data/README.md. A miss here is expected, not
  // an error condition, so every failure mode falls back to `product: null` rather than
  // bubbling up.
  let product: LoaderData["product"] = null;
  try {
    const response = await admin.graphql(
      `#graphql
        query ProductConfigurationPreviewLookup($query: String!) {
          productVariants(first: 1, query: $query) {
            nodes {
              product {
                title
                description
                featuredImage { url altText }
                images(first: 8) { nodes { url altText } }
              }
            }
          }
        }`,
      { variables: { query: `sku:"${sku.replace(/"/g, '\\"')}"` } },
    );
    const json = await response.json();
    const node = json?.data?.productVariants?.nodes?.[0];
    if (node?.product) {
      const images: ProductMediaImage[] = (node.product.images?.nodes ?? []).map(
        (image: { url: string; altText: string | null }) => ({ url: image.url, altText: image.altText }),
      );
      product = {
        title: node.product.title ?? null,
        description: node.product.description ?? null,
        images,
      };
    }
  } catch (error) {
    console.warn("[app.product-configuration] Shopify product lookup skipped:", error);
  }

  return { sku, catalog, catalogError, product } satisfies LoaderData;
};

/**
 * Recalculates price for one configuration. Thin wrapper around the same
 * `handlePricingApiRequest` the storefront pricing API (`app/routes/api.pricing.tsx`)
 * uses — no calculation logic is duplicated here. `shopDomain` comes only from the
 * authenticated admin session, never from the posted body.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Submitted as a single form field (see `submitCalculation` below) rather than
  // `fetcher.submit(obj, { encType: "application/json" })` — react-router's JSON submit
  // typing requires an index-signature type, which a well-typed `CalculationRequestBody`
  // interface deliberately isn't; encoding the JSON as one form field keeps both ends
  // strongly typed without an `any` escape hatch.
  let rawBody: unknown;
  try {
    const formData = await request.formData();
    const payload = formData.get("payload");
    if (typeof payload !== "string") throw new Error("missing payload field");
    rawBody = JSON.parse(payload);
  } catch {
    return Response.json({ ok: false, error: { code: "MALFORMED_JSON", message: "Request body must be valid JSON." } }, { status: 400 });
  }

  const result = await handlePricingApiRequest(prisma, session.shop, rawBody);
  return Response.json(result.body, { status: result.status });
};

/**
 * A pricing recalculation is a fetcher `POST` to this route's own action — it never
 * changes what the loader returns (sku / catalog / product). Revalidating the loader on
 * every POST re-hit Shopify Admin on every keystroke AND minted a fresh `catalog`
 * object that retriggered the recalculation effect → an endless loop that also emitted
 * `shop: null` revalidation requests. See `productConfigurationShouldRevalidate`.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({ formMethod, defaultShouldRevalidate }) =>
  productConfigurationShouldRevalidate(formMethod, defaultShouldRevalidate);

export default function ProductConfigurationPreview() {
  const { sku, catalog, catalogError, product } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [state, setState] = useState<ProductConfigurationState | null>(() =>
    catalog ? buildDefaultConfigurationState(catalog) : null,
  );
  const [outcome, setOutcome] = useState<PricingCalculationOutcome>({ status: "idle" });
  const [showQuoteModal, setShowQuoteModal] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The canonical input fingerprint of the calculation most recently *submitted* (set
  // at submit time, BEFORE the request goes out). This is the single source of
  // deduplication — an error response, a success response, a loader revalidation, and
  // an unrelated rerender all leave the fingerprint unchanged, so none of them
  // resubmit. Only a genuine input change flips it.
  const lastSubmittedFingerprintRef = useRef<string | null>(null);
  // Identity of the last `fetcher.data` already applied to `outcome` — so the same
  // response is never applied twice (StrictMode double-invoke, fetcher object churn).
  const processedFetcherDataRef = useRef<unknown>(null);
  const skuRef = useRef(sku);

  const ready = !!catalog && !!state && !catalogError;
  const fingerprint = ready && state ? buildCalculationFingerprint(sku, state) : "";

  // A real navigation changed the previewed SKU — reset the configuration to the new
  // product's defaults and allow exactly one fresh calculation for it.
  useEffect(() => {
    if (skuRef.current === sku) return;
    skuRef.current = sku;
    setState(catalog ? buildDefaultConfigurationState(catalog) : null);
    lastSubmittedFingerprintRef.current = null;
    processedFetcherDataRef.current = null;
    setOutcome({ status: "idle" });
  }, [sku, catalog]);

  // Recalculation effect. Deps are PRIMITIVES ONLY (`ready`, `fingerprint`) — never
  // `catalog`, `fetcher`, `fetcher.data`, `outcome`, `product`, `state` identity, or
  // any freshly-created object — so a loader revalidation, a response arriving, or an
  // unrelated rerender cannot retrigger it. It submits only when the fingerprint
  // genuinely changes (see `shouldSubmitCalculation`), debounced so rapid changes
  // calculate only the latest state.
  useEffect(() => {
    if (
      !shouldSubmitCalculation({
        ready,
        fingerprint,
        lastSubmittedFingerprint: lastSubmittedFingerprintRef.current,
      })
    ) {
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Re-check after the debounce: a newer change may already have been submitted
      // (only the latest fingerprint is ever calculated), or this exact one already is.
      if (lastSubmittedFingerprintRef.current === fingerprint || !state) return;
      lastSubmittedFingerprintRef.current = fingerprint; // mark BEFORE submit — an error never resubmits the same input
      processedFetcherDataRef.current = null;
      setOutcome({ status: "loading" });
      fetcher.submit(
        { payload: JSON.stringify(buildCalculationRequestBody(sku, state)) },
        { method: "POST" },
      );
    }, RECALCULATE_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fingerprint]);

  // Apply the fetcher's response exactly once, when it settles.
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const data = fetcher.data as ApiResponseBody | undefined;
    if (!data || processedFetcherDataRef.current === data) return;
    processedFetcherDataRef.current = data;
    if (data.ok) {
      setOutcome({ status: "success", result: data.data });
    } else {
      setOutcome({ status: "error", code: data.error.code, message: data.error.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // The shared "Selected Configuration" view model — one derivation, consumed by both
  // the Price Summary and the Request-a-Quote snapshot. Pure/memoized: it never submits,
  // never touches the calculation fingerprint, and cannot retrigger the recalc effect
  // (whose deps are primitives only). Recomputes only when the catalog, the selections,
  // or the priced outcome actually change.
  const selectedConfigurationRows = useMemo(
    () =>
      catalog && state
        ? buildSelectedConfigurationRows(catalog, state, outcome.status === "success" ? outcome.result : null)
        : [],
    [catalog, state, outcome],
  );

  if (catalogError) {
    return (
      <s-page heading="Product Configuration">
        <s-section>
          <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
            <strong>Pricing is not available for SKU &quot;{sku}&quot;.</strong>
            <p>
              {catalogError.code === "PRICING_PROFILE_NOT_FOUND" || catalogError.code === "STORE_NOT_FOUND"
                ? "This product has no pricing profile configured yet."
                : catalogError.message}
            </p>
          </div>
        </s-section>
      </s-page>
    );
  }

  if (!catalog || !state) {
    return (
      <s-page heading="Product Configuration">
        <s-section>
          <p>Loading…</p>
        </s-section>
      </s-page>
    );
  }

  const productTitle = product?.title ?? catalog.sku ?? sku;
  const productDescription = product?.description ?? null;
  const attachmentGroups = selectAttachmentGroups(catalog);
  const featureGroups = selectFeatureGroups(catalog);
  const genericGroups = selectGenericGroups(catalog);

  function updateState(patch: Partial<ProductConfigurationState>) {
    setState((current) => (current ? { ...current, ...patch } : current));
  }

  // One handler for every OptionGroup selector (attachment, feature, generic). A null
  // value clears the selection for that group.
  function handleOptionChange(groupName: string, optionValueId: string | null) {
    setState((current) => {
      if (!current) return current;
      const next = { ...current.selectedOptionValueIds };
      if (optionValueId) next[groupName] = optionValueId;
      else delete next[groupName];
      return { ...current, selectedOptionValueIds: next };
    });
  }

  return (
    <s-page heading="Product Configuration">
      <div className={styles.page}>
        <div className={styles.layout}>
          <ProductMedia images={product?.images ?? []} productTitle={productTitle} />

          <div className={styles.config}>
            <ProductHeader title={productTitle} sku={sku} description={productDescription} />

            <QuantitySelector
              tiers={catalog.quantityTiers}
              quantity={state.quantity}
              onChange={(quantity) => updateState({ quantity })}
            />

            <DecorationMethodSelector
              methods={catalog.decorationMethods}
              selected={state.decorationMethod}
              onChange={(decorationMethod) => updateState({ decorationMethod })}
            />

            <ImprintLocationSelector locations={state.locations} onChange={(locations) => updateState({ locations })} />

            <ColorCountSelector colors={state.colors} onChange={(colors) => updateState({ colors })} />

            <DecorationOptionsToggles
              reverseSide={state.reverseSide}
              differentReverseArtwork={state.differentReverseArtwork}
              repeatOrder={state.repeatOrder}
              onReverseSideChange={(reverseSide) => updateState({ reverseSide })}
              onDifferentReverseArtworkChange={(differentReverseArtwork) => updateState({ differentReverseArtwork })}
              onRepeatOrderChange={(repeatOrder) => updateState({ repeatOrder })}
            />

            <ProductColorSelector
              colors={catalog.productColors}
              selectedCode={state.productColorCode}
              onChange={(productColorCode) => updateState({ productColorCode })}
            />

            <AttachmentsSection
              groups={attachmentGroups}
              selectedOptionValueIds={state.selectedOptionValueIds}
              onOptionChange={handleOptionChange}
            />

            {featureGroups.map((group) => (
              <OptionGroupSelector
                key={group.name}
                group={group}
                selectedOptionValueId={state.selectedOptionValueIds[group.name] ?? null}
                onChange={(optionValueId) => handleOptionChange(group.name, optionValueId)}
              />
            ))}

            {genericGroups.map((group) => (
              <OptionGroupSelector
                key={group.name}
                group={group}
                selectedOptionValueId={state.selectedOptionValueIds[group.name] ?? null}
                onChange={(optionValueId) => handleOptionChange(group.name, optionValueId)}
              />
            ))}

            <ProductionSelector
              rules={catalog.productionRules}
              selectedCode={state.productionCode}
              onChange={(productionCode) => updateState({ productionCode })}
            />

            <PricingSummary outcome={outcome} selectedConfigurationRows={selectedConfigurationRows} />

            <ActionButtons outcome={outcome} onRequestQuote={() => setShowQuoteModal(true)} />
          </div>
        </div>
      </div>

      {showQuoteModal ? (
        <QuoteRequestModal
          productTitle={productTitle}
          sku={sku}
          configurationSummary={buildQuoteSummary(catalog, state)}
          onClose={() => setShowQuoteModal(false)}
        />
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <s-page heading="Product Configuration">
      <s-section>
        <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
          Something went wrong loading this page.
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
