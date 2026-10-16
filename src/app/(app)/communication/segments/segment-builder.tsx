"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";
import { humanize } from "@/components/erp/format";

type FieldDef = { field: string; type: string; values: string[]; ops: string[] };
type Filter = { field: string; op: string; value?: unknown };
type Preview = {
  total: number; withAddress: number; unique: number; eligible: number;
  blocked: Record<string, number>; sample: { name: string; address: string; status: string }[];
};

const OP_LABELS: Record<string, string> = { eq: "is", neq: "is not", in: "is any of", not_in: "is none of", contains: "contains", gte: "on or after", lte: "on or before", is_set: "is set", not_set: "is empty" };
const LIST_OPS = ["in", "not_in"];

/** Segment editor with a live audience preview. Filters are validated again by the API. */
export function SegmentBuilder({
  catalog,
  segment,
  canEdit,
}: {
  catalog: Record<string, FieldDef[]>;
  segment?: { id: string; name: string; entity: string; filters: Filter[] };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(segment?.name ?? "");
  const [entity, setEntity] = useState(segment?.entity ?? "CUSTOMER");
  const [filters, setFilters] = useState<Filter[]>(segment?.filters ?? []);
  const [channel, setChannel] = useState("EMAIL");
  const [purpose, setPurpose] = useState("MARKETING");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState(false);
  const fields = catalog[entity] ?? [];
  const def = (field: string) => fields.find((f) => f.field === field);

  const update = (i: number, patch: Partial<Filter>) => setFilters((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = () => fields[0] && setFilters((fs) => [...fs, { field: fields[0].field, op: fields[0].ops[0] }]);

  async function run<T>(fn: () => Promise<T>, done?: (v: T) => void) {
    setPending(true);
    try {
      done?.(await fn());
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  const doPreview = () => run(() => apiFetch<Preview>("/segments/preview", { method: "POST", body: { entity, filters, channel, purpose } }), setPreview);
  const save = () =>
    run(
      () => apiFetch<{ id: string }>(segment ? `/segments/${segment.id}` : "/segments", { method: segment ? "PATCH" : "POST", body: { name, entity, filters } }),
      (s) => {
        toast.success("Segment saved");
        if (segment) router.refresh();
        else router.push(`/communication/segments/${s.id}`);
      },
    );

  function valueInput(f: Filter, i: number) {
    const d = def(f.field);
    if (!d || f.op === "is_set" || f.op === "not_set") return null;
    const list = LIST_OPS.includes(f.op);
    if (d.type === "enum" && !list) {
      return <Select aria-label="Value" value={String(f.value ?? "")} onChange={(e) => update(i, { value: e.target.value })}><option value="">Choose…</option>{d.values.map((v) => <option key={v} value={v}>{humanize(v)}</option>)}</Select>;
    }
    if (d.type === "boolean") {
      return <Select aria-label="Value" value={String(f.value ?? "")} onChange={(e) => update(i, { value: e.target.value === "true" })}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></Select>;
    }
    if (d.type === "date") return <Input type="date" aria-label="Value" value={String(f.value ?? "")} onChange={(e) => update(i, { value: e.target.value })} />;
    return (
      <Input
        aria-label="Value"
        placeholder={list ? (d.values.length ? d.values.join(", ") : "comma, separated") : ""}
        value={list ? (Array.isArray(f.value) ? f.value.join(", ") : "") : String(f.value ?? "")}
        onChange={(e) => update(i, { value: list ? e.target.value.split(",").map((v) => v.trim()).filter(Boolean) : e.target.value })}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={!canEdit} /></Field>
        <Field label="Audience">
          <Select value={entity} disabled={!canEdit} onChange={(e) => { setEntity(e.target.value); setFilters([]); setPreview(null); }}>
            <option value="CUSTOMER">Customers</option>
            <option value="CONTACT">Customer contacts</option>
            <option value="LEAD">Leads (only those you can see)</option>
          </Select>
        </Field>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Filters <span className="text-2xs font-normal text-subtle">(all must match)</span></p>
        {filters.length === 0 ? <p className="text-sm text-muted">No filters: everyone in this audience.</p> : null}
        {filters.map((f, i) => {
          const d = def(f.field);
          return (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
              <Select aria-label="Field" value={f.field} disabled={!canEdit} onChange={(e) => update(i, { field: e.target.value, op: def(e.target.value)?.ops[0] ?? "eq", value: undefined })}>
                {fields.map((x) => <option key={x.field} value={x.field}>{humanize(x.field.replace(".", " "))}</option>)}
              </Select>
              <Select aria-label="Operator" value={f.op} disabled={!canEdit} onChange={(e) => update(i, { op: e.target.value, value: undefined })}>
                {(d?.ops ?? []).map((o) => <option key={o} value={o}>{OP_LABELS[o] ?? o}</option>)}
              </Select>
              <div>{valueInput(f, i)}</div>
              {canEdit ? <Button type="button" size="sm" variant="ghost" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>Remove</Button> : <span />}
            </div>
          );
        })}
        {canEdit ? <Button type="button" size="sm" variant="secondary" onClick={add}>Add filter</Button> : null}
      </div>

      <div className="flex flex-wrap items-end gap-2 border-t border-[var(--ic-border)] pt-3">
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="EMAIL">Email</option><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option></Select>
        </Field>
        <Field label="Purpose">
          <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}><option value="MARKETING">Marketing</option><option value="TRANSACTIONAL">Transactional</option></Select>
        </Field>
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={doPreview}>Preview audience</Button>
        {canEdit ? <Button type="button" size="sm" disabled={pending || !name.trim()} onClick={save}>{segment ? "Save changes" : "Save segment"}</Button> : null}
      </div>

      {preview ? (
        <div className="space-y-3 rounded-xl border border-[var(--ic-border)] p-3 text-sm">
          <p>
            <strong>{preview.eligible}</strong> can be messaged · {preview.total} matched · {preview.withAddress} with an address ({preview.unique} distinct)
          </p>
          <p className="text-muted">
            Blocked: no consent {preview.blocked.NO_CONSENT} · opted out {preview.blocked.OPTED_OUT} · missing or invalid address {preview.blocked.INVALID_ADDRESS}
          </p>
          {preview.sample.length ? (
            <ul className="space-y-1 text-xs">
              {preview.sample.map((s, i) => (
                <li key={i} className="flex flex-wrap gap-2"><span className="font-medium">{s.name}</span><span className="text-muted">{s.address || "—"}</span><span className="text-subtle">{humanize(s.status)}</span></li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
