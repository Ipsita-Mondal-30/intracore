"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";

type EntryType = "OPENING" | "RECEIPT" | "ISSUE" | "ADJUSTMENT" | "TRANSFER";
export type EntryScopeOption = { value: string; label: string }; // "companyId:branchId" (branch may be empty)
export type EntryWarehouseOption = { id: string; companyId: string; label: string };
export type EntryProductOption = { id: string; sku: string; name: string; uom: string; trackingMode: string; hasExpiry: boolean; cost: string };

type Line = { productId: string; quantity: string; unitCost: string; lotNumber: string; expiryDate: string };
const blank: Line = { productId: "", quantity: "", unitCost: "", lotNumber: "", expiryDate: "" };

const TYPES: { value: EntryType; label: string }[] = [
  { value: "OPENING", label: "Opening stock" },
  { value: "RECEIPT", label: "Receipt" },
  { value: "ISSUE", label: "Issue" },
  { value: "ADJUSTMENT", label: "Adjustment (+ found / − lost)" },
  { value: "TRANSFER", label: "Transfer" },
];

export function StockEntryForm({
  scopes,
  warehouses,
  products,
  canPost,
}: {
  scopes: EntryScopeOption[];
  warehouses: EntryWarehouseOption[];
  products: EntryProductOption[];
  canPost: boolean;
}) {
  const router = useRouter();
  const [type, setType] = useState<EntryType>("OPENING");
  const [scope, setScope] = useState(scopes[0]?.value ?? "");
  const [sourceWarehouseId, setSource] = useState("");
  const [targetWarehouseId, setTarget] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([blank]);
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [pending, setPending] = useState(false);

  const [companyId, branchId] = scope.split(":");
  const companyWarehouses = warehouses.filter((w) => w.companyId === companyId);
  const byId = new Map(products.map((p) => [p.id, p]));
  const needsSource = type === "ISSUE" || type === "TRANSFER";
  const needsTarget = type !== "ISSUE";
  const costFor = (l: Line) => type === "OPENING" || type === "RECEIPT" || (type === "ADJUSTMENT" && Number(l.quantity) > 0);
  const update = (i: number, patch: Partial<Line>) => setLines((c) => c.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit(event: FormEvent<HTMLFormElement>, post: boolean) {
    event.preventDefault();
    setPending(true);
    setErrors([]);
    try {
      const body = {
        companyId,
        branchId: branchId || null,
        type,
        sourceWarehouseId: needsSource ? sourceWarehouseId || null : null,
        targetWarehouseId: needsTarget ? targetWarehouseId || null : null,
        reference: reference || null,
        notes: notes || null,
        post,
        lines: lines
          .filter((l) => l.productId)
          .map((l) => {
            const product = byId.get(l.productId);
            return {
              productId: l.productId,
              quantity: l.quantity,
              unitCost: costFor(l) && l.unitCost ? l.unitCost : null,
              lotNumber: product && product.trackingMode !== "NONE" && l.lotNumber ? l.lotNumber : null,
              expiryDate: product?.hasExpiry && l.expiryDate ? l.expiryDate : null,
            };
          }),
      };
      const entry = await apiFetch<{ id: string }>("/stock-entries", { method: "POST", body });
      toast.success(post ? "Entry posted" : "Draft saved");
      router.push(`/inventory/entries/${entry.id}`);
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors((error.details ?? []).filter((d) => d.path !== undefined).map((d) => ({ path: String(d.path), message: String(d.message) })));
        toast.error(error.message);
      } else {
        toast.error("Something went wrong");
      }
    } finally {
      setPending(false);
    }
  }

  const label = (path: string) => path.replace(/^lines\.(\d+)\.(\w+)$/, (_, i: string, f: string) => `Line ${Number(i) + 1} ${f}`);
  const warehouseSelect = (value: string, onChange: (v: string) => void, aria: string) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)} required aria-label={aria}>
      <option value="" disabled>Select…</option>
      {companyWarehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
    </Select>
  );

  return (
    <form onSubmit={(e) => submit(e, (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "post")} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as EntryType)}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label="Company / branch">
          <Select value={scope} onChange={(e) => { setScope(e.target.value); setSource(""); setTarget(""); }}>
            {scopes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        {needsSource ? <Field label={type === "TRANSFER" ? "From warehouse" : "Warehouse"}>{warehouseSelect(sourceWarehouseId, setSource, "Source warehouse")}</Field> : null}
        {needsTarget ? <Field label={type === "TRANSFER" ? "To warehouse" : "Warehouse"}>{warehouseSelect(targetWarehouseId, setTarget, "Target warehouse")}</Field> : null}
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
      {companyWarehouses.length === 0 ? <p className="text-xs text-danger">This company has no warehouses yet.</p> : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
            <tr>
              <th className="py-1 pr-2">Product</th>
              <th className="w-32 py-1 pr-2">Qty</th>
              <th className="w-32 py-1 pr-2">Unit cost</th>
              <th className="w-36 py-1 pr-2">Lot / serial</th>
              <th className="w-40 py-1 pr-2">Expiry</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const product = byId.get(line.productId);
              return (
                <tr key={i} className="align-top">
                  <td className="py-1 pr-2">
                    <Select value={line.productId} onChange={(e) => update(i, { productId: e.target.value })} aria-label="Product">
                      <option value="">Select product…</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
                    </Select>
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      type="number"
                      step="any"
                      min={type === "ADJUSTMENT" ? undefined : "0"}
                      value={line.quantity}
                      required={Boolean(line.productId)}
                      placeholder={product?.uom}
                      onChange={(e) => update(i, { quantity: e.target.value })}
                      aria-label="Quantity"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    {costFor(line) ? (
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        value={line.unitCost}
                        required={type === "OPENING" && Boolean(line.productId)}
                        placeholder={product?.cost ?? "0.00"}
                        onChange={(e) => update(i, { unitCost: e.target.value })}
                        aria-label="Unit cost"
                      />
                    ) : <span className="text-2xs text-subtle">Average cost</span>}
                  </td>
                  <td className="py-1 pr-2">
                    {product && product.trackingMode !== "NONE" ? (
                      <Input value={line.lotNumber} onChange={(e) => update(i, { lotNumber: e.target.value })} aria-label="Lot number" />
                    ) : null}
                  </td>
                  <td className="py-1 pr-2">
                    {product?.hasExpiry ? (
                      <Input type="date" value={line.expiryDate} onChange={(e) => update(i, { expiryDate: e.target.value })} aria-label="Expiry date" />
                    ) : null}
                  </td>
                  <td className="py-1">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setLines((c) => c.filter((_, j) => j !== i))} aria-label="Remove line">×</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={() => setLines((c) => [...c, blank])}>Add line</Button>

      <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

      {errors.length > 0 ? (
        <ul className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
          {errors.map((e) => <li key={e.path}><strong>{label(e.path)}: </strong>{e.message}</li>)}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="secondary" value="draft" disabled={pending}>{pending ? "Saving…" : "Save draft"}</Button>
        {canPost ? <Button type="submit" size="sm" value="post" disabled={pending}>Save &amp; post</Button> : null}
      </div>
    </form>
  );
}
