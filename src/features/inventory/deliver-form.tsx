"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type DeliverLine = { id: string; label: string; open: string; uom: string; needsLot: boolean };

/** Deliver open sales order lines; posts immediately (issues stock, consumes reservations). */
export function DeliverForm({ orderId, lines }: { orderId: string; lines: DeliverLine[] }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.id, l.open])));
  const [lots, setLots] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = {
      lines: lines
        .filter((l) => Number(qty[l.id]) > 0)
        .map((l) => ({ salesOrderLineId: l.id, quantity: qty[l.id], lotNumber: l.needsLot && lots[l.id] ? lots[l.id] : null })),
    };
    if (body.lines.length === 0) return toast.error("Enter a quantity to deliver");
    setPending(true);
    try {
      await apiFetch(`/sales-orders/${orderId}/deliver`, { method: "POST", body });
      toast.success("Delivery posted");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Delivery failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      {lines.map((l) => (
        <div key={l.id} className="space-y-1 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span>
              {l.label}
              <span className="block text-2xs text-subtle">Open {l.open} {l.uom}</span>
            </span>
            <Input
              type="number"
              step="any"
              min="0"
              max={l.open}
              className="w-24"
              value={qty[l.id] ?? ""}
              onChange={(e) => setQty((c) => ({ ...c, [l.id]: e.target.value }))}
              aria-label={`Deliver quantity for ${l.label}`}
            />
          </div>
          {l.needsLot ? (
            <Input placeholder="Lot / serial number" value={lots[l.id] ?? ""} onChange={(e) => setLots((c) => ({ ...c, [l.id]: e.target.value }))} aria-label={`Lot for ${l.label}`} />
          ) : null}
        </div>
      ))}
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Delivering…" : "Deliver"}</Button>
    </form>
  );
}
