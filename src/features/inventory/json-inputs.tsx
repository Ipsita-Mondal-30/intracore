"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

/** Return quantities per original line, inside an ApiForm; blank lines are skipped. */
export function ReturnLinesInput({ lines }: { lines: { id: string; label: string; returnable: string; uom: string }[] }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const payload = lines.filter((l) => Number(qty[l.id]) > 0).map((l) => ({ entryLineId: l.id, quantity: qty[l.id] }));
  return (
    <div className="space-y-2">
      <input type="hidden" name="lines" data-json value={JSON.stringify(payload)} />
      {lines.map((l) => (
        <label key={l.id} className="flex items-center justify-between gap-3 text-sm">
          <span>
            {l.label}
            <span className="block text-2xs text-subtle">Up to {l.returnable} {l.uom}</span>
          </span>
          <Input
            type="number"
            step="any"
            min="0"
            max={l.returnable}
            className="w-28"
            value={qty[l.id] ?? ""}
            onChange={(e) => setQty((c) => ({ ...c, [l.id]: e.target.value }))}
            aria-label={`Return quantity for ${l.label}`}
          />
        </label>
      ))}
    </div>
  );
}

type Conversion = { uomId: string; factor: string };

/** Existing unit conversions plus one new row; clear a factor to remove a conversion. */
export function ConversionsInput({ initial, uoms, baseUom }: { initial: Conversion[]; uoms: { id: string; code: string }[]; baseUom: string }) {
  const [rows, setRows] = useState<Conversion[]>([...initial, { uomId: "", factor: "" }]);
  const payload = rows.filter((r) => r.uomId && Number(r.factor) > 0);
  const update = (i: number, patch: Partial<Conversion>) => setRows((c) => c.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <input type="hidden" name="conversions" data-json value={JSON.stringify(payload)} />
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span className="text-muted">1</span>
          <Select value={r.uomId} onChange={(e) => update(i, { uomId: e.target.value })} className="w-28" aria-label="Unit">
            <option value="">Unit…</option>
            {uoms.map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}
          </Select>
          <span className="text-muted">=</span>
          <Input type="number" step="any" min="0" value={r.factor} onChange={(e) => update(i, { factor: e.target.value })} className="w-24" aria-label="Factor" />
          <span className="text-muted">{baseUom}</span>
        </div>
      ))}
    </div>
  );
}
