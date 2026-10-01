import type { PricingDraft } from "../../lib/pricing-editor/draft.ts";

const box = { border: "1px solid #e3e3e3", borderRadius: 8, padding: "0.75rem", display: "grid", gap: "0.6rem" };
const row = { display: "flex", gap: "0.5rem", flexWrap: "wrap" as const, alignItems: "end" };

function Field({ label, value, onChange, width, inputMode, placeholder }: { label: string; value: string; onChange: (value: string) => void; width: string; inputMode?: "decimal" | "numeric" | "text"; placeholder?: string }) {
  return <label style={{ display: "grid", gap: "0.2rem", width, minWidth: 0 }}><span style={{ fontSize: "0.8rem", color: "#616161" }}>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} inputMode={inputMode} placeholder={placeholder} style={{ width: "100%", boxSizing: "border-box" }} /></label>;
}

export function OptionGroupsEditor({ draft, update, onlyAttachments = false, onlyFeatures = false }: { draft: PricingDraft; update: (fn: (draft: PricingDraft) => void) => void; onlyAttachments?: boolean; onlyFeatures?: boolean }) {
  const groups = draft.optionGroups.map((group, index) => ({ group, index, isAttachment: group.kind === "ATTACHMENT" || /attachment/i.test(group.name) })).filter(({ isAttachment }) => (!onlyAttachments || isAttachment) && (!onlyFeatures || !isAttachment));
  return <div style={{ display: "grid", gap: "0.75rem" }}>
    {groups.map(({ group: g, index: gi }) => <div key={gi} style={box}>
      <div style={row}>
        <Field label="Group name" value={g.name} onChange={(value) => update((draft) => (draft.optionGroups[gi]!.name = value))} width="16rem" />
        {!onlyAttachments ? <label style={{ display: "grid", gap: "0.2rem" }}><span style={{ fontSize: "0.8rem", color: "#616161" }}>Shown under</span><select value={g.kind} onChange={(event) => update((draft) => (draft.optionGroups[gi]!.kind = event.target.value))}><option value="ATTACHMENT">Attachments</option><option value="FEATURE">Optional features</option><option value="GENERIC">Optional features (generic)</option></select></label> : null}
        <label style={{ display: "flex", gap: "0.35rem", alignItems: "center", paddingBottom: "0.35rem" }}><input type="checkbox" checked={g.isRequired} onChange={(event) => update((draft) => (draft.optionGroups[gi]!.isRequired = event.target.checked))} />Customer must choose one</label>
        <button type="button" onClick={() => update((draft) => draft.optionGroups.splice(gi, 1))}>Remove group</button>
      </div>
      {g.values.map((value, vi) => <div key={vi} style={row}>
        <Field label={onlyAttachments ? "Attachment" : "Choice"} value={value.label} onChange={(next) => update((draft) => (draft.optionGroups[gi]!.values[vi]!.label = next))} width="14rem" />
        <Field label="Code" value={value.code} onChange={(next) => update((draft) => (draft.optionGroups[gi]!.values[vi]!.code = next))} width="7rem" />
        <Field label="List (+)" value={value.list} inputMode="decimal" onChange={(next) => update((draft) => (draft.optionGroups[gi]!.values[vi]!.list = next))} width="7rem" />
        <Field label="Net (+)" value={value.net} inputMode="decimal" placeholder="same as list" onChange={(next) => update((draft) => (draft.optionGroups[gi]!.values[vi]!.net = next))} width="7rem" />
        <label style={{ display: "flex", gap: "0.35rem", alignItems: "center", paddingBottom: "0.35rem" }}><input type="checkbox" checked={value.isDefault} onChange={(event) => update((draft) => (draft.optionGroups[gi]!.values[vi]!.isDefault = event.target.checked))} />Included</label>
        <button type="button" onClick={() => update((draft) => draft.optionGroups[gi]!.values.splice(vi, 1))} aria-label={`Remove ${value.label || "choice"}`}>Remove</button>
      </div>)}
      <div><button type="button" onClick={() => update((draft) => draft.optionGroups[gi]!.values.push({ label: "", code: "", list: "", net: "", isDefault: false }))}>{onlyAttachments ? "Add attachment" : "Add choice"}</button></div>
    </div>)}
    <button type="button" onClick={() => update((draft) => draft.optionGroups.push({ name: "", kind: onlyFeatures ? "FEATURE" : "ATTACHMENT", isRequired: false, values: [{ label: "", code: "", list: "", net: "", isDefault: false }] }))}>{onlyAttachments ? "Add attachment group" : "Add option group"}</button>
  </div>;
}
