"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";

export type DebitableLine = { id: string; description: string; sku: string; uom: string; remaining: string; unitPrice: string };

/** Draft debit note against a posted bill: quantity per bill line (0 = skip) and a reason. */
export function DebitNoteForm({ billId, lines, today }: { billId: string; lines: DebitableLine[]; today: string }) {
  const router = useRouter();
  const [qty, setQty] = useState<string[]>(() => lines.map(() => "0"));
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = lines.flatMap((l, i) => (Number(qty[i]) > 0 ? [{ billLineId: l.id, quantity: qty[i] }] : []));
    if (payload.length === 0) {
      setErrors(["Enter a quantity for at least one line."]);
      return;
    }
    setPending(true);
    setErrors([]);
    try {
      const note = await apiFetch<{ id: string }>("/debit-notes", {
        method: "POST",
        body: { billId, noteDate: String(form.get("noteDate") ?? ""), reason: String(form.get("reason") ?? "").trim(), lines: payload },
      });
      toast.success("Debit note drafted");
      router.push(`/finance/debit-notes/${note.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors([e.message, ...(e.details ?? []).map((d) => `${d.path !== undefined ? `${String(d.path)}: ` : ""}${String(d.message ?? "")}`)]);
        toast.error(e.message);
      } else {
        toast.error("Something went wrong");
      }
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
              <th className="py-1 pr-2 text-right">Can debit</th>
              <th className="py-1 pr-2 text-right">Rate</th>
              <th className="w-32 py-1">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="align-top">
                <td className="py-1 pr-2">
                  <p className="font-medium">{l.description}</p>
                  <p className="text-2xs text-subtle">{l.sku}</p>
                </td>
                <td className="py-1 pr-2 text-right">{l.remaining} {l.uom}</td>
                <td className="py-1 pr-2 text-right">{l.unitPrice}</td>
                <td className="py-1">
                  <Input
                    type="number"
                    min="0"
                    max={l.remaining}
                    step="any"
                    value={qty[i]}
                    onChange={(e) => setQty((q) => q.map((v, j) => (j === i ? e.target.value : v)))}
                    aria-label={`Debit quantity for ${l.description}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Note date"><Input type="date" name="noteDate" defaultValue={today} required /></Field>
        <Field label="Reason" className="sm:col-span-2"><Textarea name="reason" rows={2} required maxLength={1000} /></Field>
      </div>
      {errors.length > 0 ? (
        <ul className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      ) : null}
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>{pending ? "Saving…" : "Draft debit note"}</Button>
    </form>
  );
}
