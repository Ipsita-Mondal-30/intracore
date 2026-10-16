"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ReceivableLine = {
  id: string;
  description: string;
  sku: string;
  uom: string;
  outstanding: string;
  needsLot: boolean;
  hasExpiry: boolean;
};

type Row = { quantity: string; lotNumber: string; expiryDate: string };

/** Receives goods against a purchase order: creates and posts a goods receipt. */
export function ReceiveForm({ purchaseOrderId, lines }: { purchaseOrderId: string; lines: ReceivableLine[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => lines.map((l) => ({ quantity: l.outstanding, lotNumber: "", expiryDate: "" })));
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const update = (i: number, patch: Partial<Row>) => setRows((current) => current.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = lines.flatMap((l, i) => {
      const r = rows[i];
      if (!(Number(r.quantity) > 0)) return [];
      return [{
        purchaseOrderLineId: l.id,
        quantity: r.quantity,
        ...(r.lotNumber ? { lotNumber: r.lotNumber } : {}),
        ...(r.expiryDate ? { expiryDate: r.expiryDate } : {}),
      }];
    });
    if (payload.length === 0) {
      setError("Enter a quantity for at least one line.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await apiFetch(`/purchase-orders/${purchaseOrderId}/receive`, {
        method: "POST",
        body: { lines: payload, ...(reference ? { reference } : {}) },
      });
      toast.success("Goods received");
      router.refresh();
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Receiving failed";
      setError(
        e instanceof ApiError && e.details?.length
          ? `${message}: ${e.details.map((d) => `${d.path !== undefined ? `${String(d.path)} ` : ""}${String(d.message ?? "")}`).join("; ")}`
          : message,
      );
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
            <tr>
              <th className="py-1 pr-2">Item</th>
              <th className="py-1 pr-2 text-right">Outstanding</th>
              <th className="w-28 py-1 pr-2">Receive</th>
              <th className="w-36 py-1 pr-2">Lot / serial</th>
              <th className="w-40 py-1">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="align-top">
                <td className="py-1 pr-2">
                  <p className="font-medium">{l.description}</p>
                  <p className="text-2xs text-subtle">{l.sku}</p>
                </td>
                <td className="py-1 pr-2 text-right">{l.outstanding} {l.uom}</td>
                <td className="py-1 pr-2">
                  <Input type="number" min="0" max={l.outstanding} step="any" value={rows[i].quantity} onChange={(e) => update(i, { quantity: e.target.value })} aria-label={`Quantity for ${l.description}`} />
                </td>
                <td className="py-1 pr-2">
                  {l.needsLot ? (
                    <Input value={rows[i].lotNumber} onChange={(e) => update(i, { lotNumber: e.target.value })} aria-label={`Lot for ${l.description}`} required={Number(rows[i].quantity) > 0} />
                  ) : <span className="text-subtle">—</span>}
                </td>
                <td className="py-1">
                  {l.hasExpiry ? (
                    <Input type="date" value={rows[i].expiryDate} onChange={(e) => update(i, { expiryDate: e.target.value })} aria-label={`Expiry for ${l.description}`} />
                  ) : <span className="text-subtle">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Delivery note / reference (optional)" className="max-w-xs" maxLength={120} />
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Receiving…" : "Receive goods"}</Button>
      </div>
      {error ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p> : null}
    </form>
  );
}
