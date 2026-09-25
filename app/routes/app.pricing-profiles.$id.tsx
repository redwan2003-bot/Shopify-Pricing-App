import { useEffect, useMemo, useState } from "react";
import type { HeadersFunction } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { editAction, editLoader } from "../lib/pricing-editor/editor-route.server.ts";
import {
  DECORATION_METHODS,
  DECORATION_SLOTS,
  type DecorationSlotKey,
  type DraftError,
  type PricingDraft,
} from "../lib/pricing-editor/draft.ts";

export const loader = editLoader;
export const action = editAction;

const METHOD_LABEL: Record<string, string> = {
  SCREEN_PRINT: "Screen print",
  SUBLIMATION: "Sublimation",
  WOVEN: "Woven",
  EMBROIDERY: "Embroidery",
  DTF: "DTF transfer",
  DTG: "DTG print",
  VINYL: "Vinyl",
  OTHER: "Other",
};
const box = { border: "1px solid #e3e3e3", borderRadius: 8, padding: "0.75rem", display: "grid", gap: "0.6rem" };
const row = { display: "flex", gap: "0.5rem", flexWrap: "wrap" as const, alignItems: "end" };

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  width?: string;
  placeholder?: string;
  readOnly?: boolean;
  inputMode?: "decimal" | "numeric" | "text";
}) {
  return (
    <label style={{ display: "grid", gap: "0.2rem", width: props.width ?? "auto", minWidth: 0 }}>
      <span style={{ fontSize: "0.8rem", color: "#616161" }}>{props.label}</span>
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        inputMode={props.inputMode}
        aria-invalid={props.error ? true : undefined}
        style={{ borderColor: props.error ? "#b42318" : undefined, width: "100%", boxSizing: "border-box" }}
      />
      {props.error ? <span style={{ fontSize: "0.78rem", color: "#b42318" }}>{props.error}</span> : null}
    </label>
  );
}

export default function PricingProfileEditor() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const busy = navigation.state !== "idle";
  const [draft, setDraft] = useState<PricingDraft>(data.draft);
  useEffect(() => setDraft(data.draft), [data.draft]);

  const errors = useMemo(() => {
    const map = new Map<string, string>();
    const list: DraftError[] = result && !result.ok ? (result.errors ?? []) : [];
    for (const e of list) if (!map.has(e.field)) map.set(e.field, e.message);
    return map;
  }, [result]);
  const err = (field: string) => errors.get(field);

  const update = (fn: (d: PricingDraft) => void) =>
    setDraft((current) => {
      const next = structuredClone(current);
      fn(next);
      return next;
    });

  const usedMethods = new Set(draft.decorations.map((d) => d.method));
  const nextMethod = DECORATION_METHODS.find((m) => !usedMethods.has(m));

  return (
    <s-page heading={data.isNew ? "Add pricing profile" : `Edit ${data.draft.sku || "pricing profile"}`}>
      <s-section>
        <Link to="/app/pricing-profiles">← All pricing profiles</Link>
        {params.get("saved") === "1" && !result ? (
          <p role="status" style={{ color: "#1a7f37" }}>
            Created.
          </p>
        ) : null}
        {result ? (
          <p role={result.ok ? "status" : "alert"} style={{ color: result.ok ? "#1a7f37" : "#b42318" }}>
            {result.message}
          </p>
        ) : null}
        {!data.canEdit ? (
          <p role="alert" style={{ color: "#8a5a00" }}>
            Your subscription isn&apos;t active, so this profile is view-only. Your storefront keeps quoting existing prices.{" "}
            <Link to="/app/billing">Subscribe to resume editing</Link>.
          </p>
        ) : null}
      </s-section>

      <Form method="post">
        <input type="hidden" name="draft" value={JSON.stringify(draft)} />

        <s-section heading="Basics">
          <div style={row}>
            <Field
              label="SKU (matches your product's variant SKUs, e.g. LNY01 for LNY01_White)"
              value={draft.sku}
              readOnly={!data.isNew}
              onChange={(v) => update((d) => (d.sku = v))}
              error={err("sku")}
              width="22rem"
            />
            <Field label="Name" value={draft.name} onChange={(v) => update((d) => (d.name = v))} error={err("name")} width="22rem" />
            <Field label="Currency" value={draft.currency} onChange={(v) => update((d) => (d.currency = v.toUpperCase()))} error={err("currency")} width="6rem" />
          </div>
          {data.shopCurrency && draft.currency !== data.shopCurrency ? (
            <p style={{ color: "#8a5a00" }}>Your store sells in {data.shopCurrency}; prices in another currency can&apos;t be checked out.</p>
          ) : null}
          <p style={{ margin: 0, color: "#616161" }}>
            {data.linkedProducts.length ? `Linked to product ${data.linkedProducts.join(", ")}.` : "Not linked to a product yet — it links automatically when a product's variant SKUs start with this SKU."}{" "}
            List price is the reference price; net price is what the customer pays. Leave a price blank if it doesn&apos;t apply.
          </p>
        </s-section>

        <s-section heading="Quantity breaks (price per piece)">
          {err("tiers") ? <p style={{ color: "#b42318" }}>{err("tiers")}</p> : null}
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {draft.tiers.map((t, i) => (
              <div key={i} style={row}>
                <Field label="From qty" value={t.min} inputMode="numeric" onChange={(v) => update((d) => (d.tiers[i]!.min = v))} error={err(`tiers.${i}.min`)} width="7rem" />
                <Field label="To qty (blank = and up)" value={t.max} inputMode="numeric" onChange={(v) => update((d) => (d.tiers[i]!.max = v))} error={err(`tiers.${i}.max`)} width="9rem" />
                <Field label="List" value={t.list} inputMode="decimal" onChange={(v) => update((d) => (d.tiers[i]!.list = v))} error={err(`tiers.${i}.list`)} width="7rem" />
                <Field label="Net" value={t.net} inputMode="decimal" onChange={(v) => update((d) => (d.tiers[i]!.net = v))} error={err(`tiers.${i}.net`)} width="7rem" />
                <button type="button" onClick={() => update((d) => d.tiers.splice(i, 1))} aria-label={`Remove quantity break ${i + 1}`}>
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button type="button" onClick={() => update((d) => d.tiers.push({ min: "", max: "", list: "", net: "" }))}>
                Add quantity break
              </button>
            </div>
          </div>
        </s-section>

        <s-section heading="Decoration charges">
          <p style={{ marginTop: 0, color: "#616161" }}>
            Only charges you fill in are offered to customers. Setup is required for each method. The storefront offers the first
            method listed.
          </p>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {draft.decorations.map((dec, i) => (
              <div key={i} style={box}>
                <div style={row}>
                  <label style={{ display: "grid", gap: "0.2rem" }}>
                    <span style={{ fontSize: "0.8rem", color: "#616161" }}>Method</span>
                    <select value={dec.method} onChange={(e) => update((d) => (d.decorations[i]!.method = e.target.value))}>
                      {DECORATION_METHODS.map((m) => (
                        <option key={m} value={m} disabled={m !== dec.method && usedMethods.has(m)}>
                          {METHOD_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => update((d) => d.decorations.splice(i, 1))}>
                    Remove method
                  </button>
                </div>
                {err(`decorations.${i}.method`) ? <span style={{ color: "#b42318" }}>{err(`decorations.${i}.method`)}</span> : null}
                {DECORATION_SLOTS.map((slot) => {
                  const s = dec.slots[slot.key as DecorationSlotKey];
                  const set = (field: "list" | "net", v: string) =>
                    update((d) => {
                      const slots = d.decorations[i]!.slots;
                      slots[slot.key] = { name: slots[slot.key]?.name ?? "", list: slots[slot.key]?.list ?? "", net: slots[slot.key]?.net ?? "", [field]: v };
                    });
                  return (
                    <div key={slot.key} style={row}>
                      <span style={{ width: "16rem", paddingBottom: "0.35rem" }}>
                        {slot.label}
                        {slot.required ? " *" : ""}
                      </span>
                      <Field label="List" value={s?.list ?? ""} inputMode="decimal" onChange={(v) => set("list", v)} error={err(`decorations.${i}.${slot.key}.list`)} width="7rem" />
                      <Field label="Net" value={s?.net ?? ""} inputMode="decimal" onChange={(v) => set("net", v)} error={err(`decorations.${i}.${slot.key}.net`)} width="7rem" />
                      {err(`decorations.${i}.${slot.key}`) ? <span style={{ color: "#b42318", paddingBottom: "0.35rem" }}>{err(`decorations.${i}.${slot.key}`)}</span> : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {nextMethod ? (
              <div>
                <button type="button" onClick={() => update((d) => d.decorations.push({ method: nextMethod, slots: {} }))}>
                  Add decoration method
                </button>
              </div>
            ) : null}
          </div>
        </s-section>

        <s-section heading="Options (price per piece)">
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {draft.optionGroups.map((g, gi) => (
              <div key={gi} style={box}>
                <div style={row}>
                  <Field label="Group name" value={g.name} onChange={(v) => update((d) => (d.optionGroups[gi]!.name = v))} error={err(`optionGroups.${gi}.name`)} width="16rem" />
                  <label style={{ display: "grid", gap: "0.2rem" }}>
                    <span style={{ fontSize: "0.8rem", color: "#616161" }}>Shown under</span>
                    <select value={g.kind} onChange={(e) => update((d) => (d.optionGroups[gi]!.kind = e.target.value))}>
                      <option value="ATTACHMENT">Attachments</option>
                      <option value="FEATURE">Optional features</option>
                      <option value="GENERIC">Optional features (generic)</option>
                    </select>
                  </label>
                  <label style={{ display: "flex", gap: "0.35rem", alignItems: "center", paddingBottom: "0.35rem" }}>
                    <input type="checkbox" checked={g.isRequired} onChange={(e) => update((d) => (d.optionGroups[gi]!.isRequired = e.target.checked))} />
                    Customer must choose one
                  </label>
                  <button type="button" onClick={() => update((d) => d.optionGroups.splice(gi, 1))}>
                    Remove group
                  </button>
                </div>
                {err(`optionGroups.${gi}.values`) ? <span style={{ color: "#b42318" }}>{err(`optionGroups.${gi}.values`)}</span> : null}
                {g.values.map((v, vi) => (
                  <div key={vi} style={row}>
                    <Field label="Choice" value={v.label} onChange={(val) => update((d) => (d.optionGroups[gi]!.values[vi]!.label = val))} error={err(`optionGroups.${gi}.values.${vi}.label`)} width="14rem" />
                    <Field label="List (+)" value={v.list} inputMode="decimal" onChange={(val) => update((d) => (d.optionGroups[gi]!.values[vi]!.list = val))} error={err(`optionGroups.${gi}.values.${vi}.list`)} width="7rem" />
                    <Field label="Net (+)" value={v.net} inputMode="decimal" placeholder="same as list" onChange={(val) => update((d) => (d.optionGroups[gi]!.values[vi]!.net = val))} error={err(`optionGroups.${gi}.values.${vi}.net`)} width="7rem" />
                    <label style={{ display: "flex", gap: "0.35rem", alignItems: "center", paddingBottom: "0.35rem" }}>
                      <input type="checkbox" checked={v.isDefault} onChange={(e) => update((d) => (d.optionGroups[gi]!.values[vi]!.isDefault = e.target.checked))} />
                      Included
                    </label>
                    <button type="button" onClick={() => update((d) => d.optionGroups[gi]!.values.splice(vi, 1))} aria-label={`Remove ${v.label || "choice"}`}>
                      Remove
                    </button>
                  </div>
                ))}
                <div>
                  <button type="button" onClick={() => update((d) => d.optionGroups[gi]!.values.push({ label: "", code: "", list: "", net: "", isDefault: false }))}>
                    Add choice
                  </button>
                </div>
              </div>
            ))}
            <div>
              <button
                type="button"
                onClick={() => update((d) => d.optionGroups.push({ name: "", kind: "ATTACHMENT", isRequired: false, values: [{ label: "", code: "", list: "", net: "", isDefault: false }] }))}
              >
                Add option group
              </button>
            </div>
          </div>
        </s-section>

        <s-section heading="Production">
          {err("production") ? <p style={{ color: "#b42318" }}>{err("production")}</p> : null}
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {draft.production.map((r, i) => (
              <div key={i} style={row}>
                <Field label="Name" value={r.name} onChange={(v) => update((d) => (d.production[i]!.name = v))} width="14rem" />
                <Field label="Code" value={r.code} onChange={(v) => update((d) => (d.production[i]!.code = v))} width="8rem" />
                <Field label="Min days" value={r.minDays} inputMode="numeric" onChange={(v) => update((d) => (d.production[i]!.minDays = v))} error={err(`production.${i}.minDays`)} width="6rem" />
                <Field label="Max days" value={r.maxDays} inputMode="numeric" onChange={(v) => update((d) => (d.production[i]!.maxDays = v))} error={err(`production.${i}.maxDays`)} width="6rem" />
                <Field label="Fee (per order)" value={r.fee} inputMode="decimal" onChange={(v) => update((d) => (d.production[i]!.fee = v))} error={err(`production.${i}.fee`)} width="8rem" />
                <label style={{ display: "flex", gap: "0.35rem", alignItems: "center", paddingBottom: "0.35rem" }}>
                  <input type="checkbox" checked={r.isRush} onChange={(e) => update((d) => (d.production[i]!.isRush = e.target.checked))} />
                  Rush
                </label>
                <button type="button" onClick={() => update((d) => d.production.splice(i, 1))}>
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                onClick={() => update((d) => d.production.push({ code: "RUSH", name: "Rush production", isRush: true, minDays: "5", maxDays: "", fee: "", notes: "" }))}
              >
                Add production option
              </button>
            </div>
          </div>
        </s-section>

        <s-section>
          <button type="submit" disabled={busy || !data.canEdit}>
            {busy ? "Saving…" : data.isNew ? "Create profile" : "Save changes"}
          </button>
        </s-section>
      </Form>
    </s-page>
  );
}

export function ErrorBoundary() {
  return (
    <s-page heading="Pricing profile">
      <s-section>
        <p role="alert">This pricing profile couldn&apos;t be loaded. It may have been removed. Go back to the list and try again.</p>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
