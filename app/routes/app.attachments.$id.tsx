import { useEffect, useState } from "react";
import type { HeadersFunction } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { editAction, editLoader } from "../lib/pricing-editor/editor-route.server.ts";
import type { PricingDraft } from "../lib/pricing-editor/draft.ts";
import { OptionGroupsEditor } from "./app.pricing-profiles/OptionGroupsEditor.tsx";

export const loader = editLoader;
export const action = editAction;

export default function AttachmentsEditor() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [draft, setDraft] = useState<PricingDraft>(data.draft);
  useEffect(() => setDraft(data.draft), [data.draft]);
  const update = (fn: (draft: PricingDraft) => void) => setDraft((current) => { const next = structuredClone(current); fn(next); return next; });
  const count = draft.optionGroups.filter((group) => group.kind === "ATTACHMENT").length;
  return <s-page heading={`Attachments · ${draft.sku || "pricing profile"}`}>
    <s-section><Link to="/app/attachments">← All attachments</Link><p>Edit verified attachment codes and per-piece prices. Other profile settings remain in Pricing profiles.</p>{result ? <p role={result.ok ? "status" : "alert"} style={{ color: result.ok ? "#1a7f37" : "#b42318" }}>{result.message}</p> : null}</s-section>
    <Form method="post"><input type="hidden" name="draft" value={JSON.stringify(draft)} /><s-section heading={`${count} attachment group${count === 1 ? "" : "s"}`}><OptionGroupsEditor draft={draft} update={update} onlyAttachments /></s-section><s-section><button type="submit" disabled={navigation.state !== "idle" || !data.canEdit}>{navigation.state !== "idle" ? "Saving…" : "Save attachments"}</button>{!data.canEdit ? <p>Subscription inactive: attachments are view-only.</p> : null}</s-section></Form>
  </s-page>;
}

export function ErrorBoundary() { return <s-page heading="Attachments"><s-section><p role="alert">This attachment profile could not be loaded.</p></s-section></s-page>; }
export const headers: HeadersFunction = (args) => boundary.headers(args);
