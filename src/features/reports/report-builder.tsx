"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type CatalogField = { key: string; label: string; type: string; values?: string[]; ops: string[]; groupable: boolean; aggregates: string[] };
type CatalogEntity = { key: string; label: string; scopeRule: string; defaultColumns: string[]; fields: CatalogField[] };
type Filter = { field: string; op: string; value?: unknown };
type Aggregate = { fn: string; field?: string };
export type Definition = { entity: string; columns: string[]; filters: Filter[]; groupBy: string[]; aggregates: Aggregate[]; sort: { field: string; dir: "asc" | "desc" }[]; limit: number };
type Result = { columns: { key: string; label: string; type: string }[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; limit: number };

const OP_LABELS: Record<string, string> = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "in (comma list)", contains: "contains", between: "between", is_null: "is empty" };
const blank = (entity: CatalogEntity): Definition => ({ entity: entity.key, columns: entity.defaultColumns, filters: [], groupBy: [], aggregates: [], sort: [], limit: 200 });

/** Driven entirely by the server catalog; the server re-validates every definition. */
export function ReportBuilder({
  catalog,
  initial,
  saved,
  canSave,
  canExport,
}: {
  catalog: CatalogEntity[];
  initial?: Definition;
  saved?: { id: string; name: string; isShared: boolean; mine: boolean };
  canSave: boolean;
  canExport: boolean;
}) {
  const router = useRouter();
  const [def, setDef] = useState<Definition>(initial ?? blank(catalog[0]));
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(saved?.name ?? "");
  const [shared, setShared] = useState(saved?.isShared ?? false);
  const entity = catalog.find((e) => e.key === def.entity) ?? catalog[0];
  const field = (k: string) => entity.fields.find((f) => f.key === k);
  const grouped = def.groupBy.length > 0 || def.aggregates.length > 0;
  const outputs = useMemo(
    () => (grouped ? [...def.groupBy, ...def.aggregates.map((a) => (a.field ? `${a.fn}_${a.field}` : a.fn))] : def.columns),
    [grouped, def],
  );
  const patch = (p: Partial<Definition>) => setDef((d) => ({ ...d, ...p }));
  const payload = (): Definition => ({ ...def, columns: grouped ? [] : def.columns, sort: def.sort.filter((s) => outputs.includes(s.field)) });

  async function act(label: string, run: () => Promise<void>) {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      toast.error(error instanceof ApiError ? `${error.message}${error.details?.[0] ? ` (${String((error.details[0] as { path?: string }).path ?? "")})` : ""}` : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }

  // Viewers of a shared report without report.build run the stored definition as-is.
  const runReport = () =>
    act("Run", async () =>
      setResult(saved && !canSave ? await apiFetch<Result>(`/saved-reports/${saved.id}/run`, { method: "POST" }) : await apiFetch<Result>("/reports/run", { method: "POST", body: payload() })),
    );
  const save = () =>
    act("Save", async () => {
      if (saved?.mine) {
        await apiFetch(`/saved-reports/${saved.id}`, { method: "PATCH", body: { name, isShared: shared, definition: payload() } });
        toast.success("Report saved");
        router.refresh();
      } else {
        const row = await apiFetch<{ id: string }>("/saved-reports", { method: "POST", body: { name, isShared: shared, definition: payload() } });
        toast.success("Report saved");
        router.push(`/analytics/reports/${row.id}`);
      }
    });
  const exportCsv = () =>
    act("Export", async () => {
      await apiFetch("/data-exports", { method: "POST", body: saved && !saved.mine ? { savedReportId: saved.id } : { definition: payload() } });
      toast.success("Export queued — download it from Settings → Exports when ready");
    });

  const setFilter = (i: number, f: Partial<Filter>) => patch({ filters: def.filters.map((x, j) => (j === i ? { ...x, ...f } : x)) });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Definition</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <label className="block max-w-sm">
            Entity
            <Select value={def.entity} onChange={(e) => { setResult(null); setDef(blank(catalog.find((x) => x.key === e.target.value)!)); }}>
              {catalog.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
            </Select>
            <span className="text-2xs text-subtle">Scope: {entity.scopeRule}</span>
          </label>

          {!grouped ? (
            <fieldset>
              <legend className="mb-1 font-medium">Columns</legend>
              <div className="flex flex-wrap gap-3">
                {entity.fields.map((f) => (
                  <label key={f.key} className="flex items-center gap-1">
                    <input type="checkbox" checked={def.columns.includes(f.key)} onChange={(e) => patch({ columns: e.target.checked ? [...def.columns, f.key] : def.columns.filter((c) => c !== f.key) })} />
                    {f.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="mb-1 font-medium">Filters</legend>
            {def.filters.map((f, i) => {
              const fd = field(f.field)!;
              return (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select className="w-44" value={f.field} onChange={(e) => setFilter(i, { field: e.target.value, op: field(e.target.value)!.ops[0], value: undefined })}>
                    {entity.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </Select>
                  <Select className="w-36" value={f.op} onChange={(e) => setFilter(i, { op: e.target.value, value: e.target.value === "is_null" ? true : undefined })}>
                    {fd.ops.map((op) => <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>)}
                  </Select>
                  <FilterValue field={fd} filter={f} onChange={(value) => setFilter(i, { value })} />
                  <Button type="button" size="sm" variant="ghost" onClick={() => patch({ filters: def.filters.filter((_, j) => j !== i) })}>Remove</Button>
                </div>
              );
            })}
            <Button type="button" size="sm" variant="secondary" disabled={def.filters.length >= 20} onClick={() => patch({ filters: [...def.filters, { field: entity.fields[0].key, op: entity.fields[0].ops[0] }] })}>Add filter</Button>
          </fieldset>

          <div className="grid gap-4 md:grid-cols-2">
            <fieldset className="space-y-2">
              <legend className="mb-1 font-medium">Group by (up to 3)</legend>
              {def.groupBy.map((g, i) => (
                <div key={i} className="flex gap-2">
                  <Select value={g} onChange={(e) => patch({ groupBy: def.groupBy.map((x, j) => (j === i ? e.target.value : x)) })}>
                    {entity.fields.filter((f) => f.groupable).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </Select>
                  <Button type="button" size="sm" variant="ghost" onClick={() => patch({ groupBy: def.groupBy.filter((_, j) => j !== i) })}>Remove</Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="secondary" disabled={def.groupBy.length >= 3} onClick={() => patch({ groupBy: [...def.groupBy, entity.fields.find((f) => f.groupable)!.key] })}>Add grouping</Button>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-1 font-medium">Aggregates</legend>
              {def.aggregates.map((a, i) => (
                <div key={i} className="flex gap-2">
                  <Select className="w-28" value={a.fn} onChange={(e) => {
                    const fn = e.target.value;
                    const first = entity.fields.find((f) => f.aggregates.includes(fn));
                    patch({ aggregates: def.aggregates.map((x, j) => (j === i ? { fn, field: fn === "count" ? undefined : first?.key } : x)) });
                  }}>
                    {["count", "sum", "avg", "min", "max"].map((fn) => <option key={fn} value={fn}>{fn}</option>)}
                  </Select>
                  <Select value={a.field ?? ""} onChange={(e) => patch({ aggregates: def.aggregates.map((x, j) => (j === i ? { ...x, field: e.target.value || undefined } : x)) })}>
                    {a.fn === "count" ? <option value="">all rows</option> : null}
                    {entity.fields.filter((f) => f.aggregates.includes(a.fn)).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </Select>
                  <Button type="button" size="sm" variant="ghost" onClick={() => patch({ aggregates: def.aggregates.filter((_, j) => j !== i) })}>Remove</Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="secondary" disabled={def.aggregates.length >= 10} onClick={() => patch({ aggregates: [...def.aggregates, { fn: "count" }] })}>Add aggregate</Button>
            </fieldset>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label>
              Sort by
              <Select className="w-48" value={def.sort[0]?.field ?? ""} onChange={(e) => patch({ sort: e.target.value ? [{ field: e.target.value, dir: def.sort[0]?.dir ?? "asc" }] : [] })}>
                <option value="">Default</option>
                {outputs.map((k) => <option key={k} value={k}>{field(k)?.label ?? k}</option>)}
              </Select>
            </label>
            <Select className="w-28" value={def.sort[0]?.dir ?? "asc"} onChange={(e) => def.sort[0] && patch({ sort: [{ ...def.sort[0], dir: e.target.value as "asc" | "desc" }] })}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </Select>
            <label>
              Row limit
              <Input className="w-28" type="number" min={1} max={1000} value={def.limit} onChange={(e) => patch({ limit: Number(e.target.value) || 200 })} />
            </label>
            <Button type="button" onClick={runReport} disabled={busy}>{busy ? "Working…" : "Run"}</Button>
            {canExport ? <Button type="button" variant="secondary" onClick={exportCsv} disabled={busy}>Export CSV</Button> : null}
          </div>

          {canSave && (!saved || saved.mine) ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-[var(--ic-border)] pt-3">
              <label>
                Report name
                <Input className="w-64" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flex items-center gap-1 pb-2">
                <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with colleagues who can see this data
              </label>
              <Button type="button" variant="secondary" onClick={save} disabled={busy || !name.trim()}>{saved ? "Save changes" : "Save report"}</Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <p className="text-2xs text-subtle">{result.rowCount} rows{result.truncated ? ` — limited to ${result.limit}; add filters or export for more` : ""}</p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr>{result.columns.map((c) => <th key={c.key} className={`py-1 pr-3 ${c.type === "money" || c.type === "number" ? "text-right" : ""}`}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-t border-[var(--ic-border)]">
                    {result.columns.map((c) => <td key={c.key} className={`py-1 pr-3 ${c.type === "money" || c.type === "number" ? "text-right tabular-nums" : ""}`}>{row[c.key] === null ? "—" : String(row[c.key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function FilterValue({ field, filter, onChange }: { field: CatalogField; filter: Filter; onChange: (v: unknown) => void }) {
  const inputType = field.type === "date" ? "date" : field.type === "number" || field.type === "money" ? "number" : "text";
  if (filter.op === "is_null") {
    return (
      <Select className="w-32" value={filter.value === false ? "false" : "true"} onChange={(e) => onChange(e.target.value === "true")}>
        <option value="true">is empty</option>
        <option value="false">is not empty</option>
      </Select>
    );
  }
  if (filter.op === "between") {
    const [lo, hi] = Array.isArray(filter.value) ? (filter.value as string[]) : ["", ""];
    return (
      <span className="flex gap-1">
        <Input className="w-36" type={inputType} value={lo ?? ""} onChange={(e) => onChange([e.target.value, hi ?? ""])} />
        <Input className="w-36" type={inputType} value={hi ?? ""} onChange={(e) => onChange([lo ?? "", e.target.value])} />
      </span>
    );
  }
  if (filter.op === "in") {
    return <Input className="w-56" placeholder="a, b, c" value={Array.isArray(filter.value) ? (filter.value as string[]).join(", ") : ""} onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />;
  }
  if (field.type === "enum") {
    return (
      <Select className="w-44" value={(filter.value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Choose…</option>
        {field.values?.map((v) => <option key={v} value={v}>{v}</option>)}
      </Select>
    );
  }
  return <Input className="w-48" type={inputType} value={(filter.value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
}
