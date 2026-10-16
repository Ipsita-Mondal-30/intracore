"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type CreditableLine = { id: string; description: string; unitPrice: string; creditable: string };

/** Drafts a credit note against a posted invoice (quantities per invoice line). */
export function CreditNoteForm({ invoiceId, lines }: { invoiceId: string; lines: CreditableLine[] }) {
  const router = useRouter();
  const [qty, setQty] = useState<string[]>(() => lines.map(() => "0"));
  const [reason, setReason] = useState("");
  const [noteDate, setNoteDate] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = lines.flatMap((l, i) => (Number(qty[i]) > 0 ? [{ invoiceLineId: l.id, quantity: qty[i] }] : []));
    if (payload.length === 0) {
      setError("Enter a quantity for at least one line.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const note = await apiFetch<{ id: string }>("/credit-notes", {
        method: "POST",
        body: { invoiceId, reason, lines: payload, ...(noteDate ? { noteDate } : {}) },
      });
      toast.success("Draft credit note created");
      router.push(`/finance/credit-notes/${note.id}`);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Creating the credit note failed";
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
            <tr>
              <th className="py-1 pr-2">Item</th>
              <th className="py-1 pr-2 text-right">Rate</th>
              <th className="py-1 pr-2 text-right">Creditable</th>
              <th className="w-28 py-1">Credit qty</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="align-top">
                <td className="py-1 pr-2">{l.description}</td>
                <td className="py-1 pr-2 text-right">{l.unitPrice}</td>
                <td className="py-1 pr-2 text-right">{l.creditable}</td>
                <td className="py-1">
                  <Input
                    type="number"
                    min="0"
                    max={l.creditable}
                    step="any"
                    value={qty[i]}
                    disabled={!(Number(l.creditable) > 0)}
                    onChange={(e) => setQty((c) => c.map((v, j) => (j === i ? e.target.value : v)))}
                    aria-label={`Credit quantity for ${l.description}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" required maxLength={1000} className="sm:col-span-2" aria-label="Reason" />
        <Input type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} aria-label="Note date (defaults to today)" title="Note date (defaults to today)" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Create draft credit note"}</Button>
      {error ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p> : null}
    </form>
  );
}
