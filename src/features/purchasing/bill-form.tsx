"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";

export type BillableLine = {
  id: string;
  description: string;
  sku: string;
  uom: string;
  billable: string;
  unitPrice: string;
};

type Row = { quantity: string; unitPrice: string };

/** Draft vendor bill against a purchase order: one row per line with unbilled received quantity. */
export function BillForm({
  purchaseOrderId,
  companyId,
  branchId,
  vendorId,
  lines,
  today,
}: {
  purchaseOrderId: string;
  companyId: string;
  branchId: string;
  vendorId: string;
  lines: BillableLine[];
  today: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => lines.map((l) => ({ quantity: l.billable, unitPrice: l.unitPrice })));
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const update = (i: number, patch: Partial<Row>) => setRows((current) => current.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "").trim();
    const payload = lines.flatMap((l, i) =>
      Number(rows[i].quantity) > 0
        ? [{ purchaseOrderLineId: l.id, quantity: rows[i].quantity, ...(rows[i].unitPrice ? { unitPrice: rows[i].unitPrice } : {}) }]
        : [],
    );
    if (payload.length === 0) {
      setErrors(["Enter a quantity for at least one line."]);
      return;
    }
    setPending(true);
    setErrors([]);
    try {
      const bill = await apiFetch<{ id: string }>("/vendor-bills", {
        method: "POST",
        body: {
          companyId,
          branchId,
          vendorId,
          purchaseOrderId,
          vendorInvoiceNumber: value("vendorInvoiceNumber"),
          billDate: value("billDate"),
          ...(value("dueDate") ? { dueDate: value("dueDate") } : {}),
          ...(value("notes") ? { notes: value("notes") } : {}),
          lines: payload,
        },
      });
      toast.success("Bill created");
      router.push(`/purchasing/bills/${bill.id}`);
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
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Vendor invoice number"><Input name="vendorInvoiceNumber" required maxLength={64} /></Field>
        <Field label="Bill date"><Input type="date" name="billDate" defaultValue={today} required /></Field>
        <Field label="Due date" hint="Defaults to the vendor's payment terms"><Input type="date" name="dueDate" /></Field>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
            <tr>
              <th className="py-1 pr-2">Item</th>
              <th className="py-1 pr-2 text-right">Billable</th>
              <th className="w-32 py-1 pr-2">Quantity</th>
              <th className="w-36 py-1">Unit price</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="align-top">
                <td className="py-1 pr-2">
                  <p className="font-medium">{l.description}</p>
                  <p className="text-2xs text-subtle">{l.sku}</p>
                </td>
                <td className="py-1 pr-2 text-right">{l.billable} {l.uom}</td>
                <td className="py-1 pr-2">
                  <Input type="number" min="0" max={l.billable} step="any" value={rows[i].quantity} onChange={(e) => update(i, { quantity: e.target.value })} aria-label={`Quantity for ${l.description}`} />
                </td>
                <td className="py-1">
                  <Input type="number" min="0" step="0.01" value={rows[i].unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value })} aria-label={`Unit price for ${l.description}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field label="Notes"><Textarea name="notes" rows={3} /></Field>
      {errors.length > 0 ? (
        <ul className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Create bill"}</Button>
    </form>
  );
}
