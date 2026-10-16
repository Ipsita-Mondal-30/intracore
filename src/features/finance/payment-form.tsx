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
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

export type OpenBill = {
  id: string;
  number: string;
  vendorInvoiceNumber: string;
  companyId: string;
  vendorId: string;
  billDate: string;
  dueDate: string | null;
  outstanding: string;
};

const METHODS = ["BANK_TRANSFER", "CHEQUE", "UPI", "CARD", "CASH", "OTHER"];
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Record (and post) a vendor payment, optionally allocated across the vendor's open bills. */
export function PaymentForm({
  companies,
  vendors,
  bankAccounts,
  bills,
  initial,
  today,
}: {
  companies: { id: string; label: string }[];
  vendors: { id: string; name: string }[];
  bankAccounts: { id: string; companyId: string; name: string }[];
  bills: OpenBill[];
  initial?: { companyId: string; vendorId: string; billId: string; amount: string };
  today: string;
}) {
  const router = useRouter();
  const [companyId, setCompanyId] = useState(initial?.companyId ?? companies[0]?.id ?? "");
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [allocations, setAllocations] = useState<Record<string, string>>(initial ? { [initial.billId]: initial.amount } : {});
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  const openBills = bills.filter((b) => b.companyId === companyId && b.vendorId === vendorId);
  const banks = bankAccounts.filter((b) => b.companyId === companyId);
  const allocated = round2(openBills.reduce((s, b) => s + (Number(allocations[b.id]) || 0), 0));
  const unallocated = round2((Number(amount) || 0) - allocated);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "").trim();
    if (unallocated < 0) {
      setErrors(["Allocations exceed the payment amount."]);
      return;
    }
    setPending(true);
    setErrors([]);
    try {
      const payment = await apiFetch<{ id: string }>("/vendor-payments", {
        method: "POST",
        body: {
          companyId,
          vendorId,
          bankAccountId: value("bankAccountId"),
          paymentDate: value("paymentDate"),
          amount,
          method: value("method"),
          ...(value("reference") ? { reference: value("reference") } : {}),
          ...(value("notes") ? { notes: value("notes") } : {}),
          allocations: openBills.flatMap((b) => (Number(allocations[b.id]) > 0 ? [{ billId: b.id, amount: allocations[b.id] }] : [])),
        },
      });
      toast.success("Payment recorded");
      router.push(`/finance/payments/${payment.id}`);
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
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Company">
          <Select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setAllocations({}); }} required>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Vendor">
          <Select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setAllocations({}); }} required>
            <option value="">Select a vendor…</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
        </Field>
        <Field label="Paid from" hint={banks.length === 0 ? "No bank/cash accounts in this company. Add one under Finance › Setup." : undefined}>
          <Select name="bankAccountId" required>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Payment date"><Input type="date" name="paymentDate" defaultValue={today} required /></Field>
        <Field label="Amount">
          <Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <Field label="Method">
          <Select name="method" defaultValue="BANK_TRANSFER">
            {METHODS.map((m) => <option key={m} value={m}>{humanize(m)}</option>)}
          </Select>
        </Field>
        <Field label="Reference" hint="UTR, cheque number…"><Input name="reference" maxLength={120} /></Field>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Allocate to bills</p>
        {!vendorId ? (
          <p className="text-sm text-muted">Choose a vendor to see their open bills.</p>
        ) : openBills.length === 0 ? (
          <p className="text-sm text-muted">No open posted bills for this vendor in this company. The payment will be recorded as an advance.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr>
                  <th className="py-1 pr-2">Bill</th>
                  <th className="py-1 pr-2">Date / due</th>
                  <th className="py-1 pr-2 text-right">Outstanding</th>
                  <th className="w-40 py-1">Allocate</th>
                </tr>
              </thead>
              <tbody>
                {openBills.map((b) => (
                  <tr key={b.id}>
                    <td className="py-1 pr-2">
                      <p className="font-medium">{b.number}</p>
                      <p className="text-2xs text-subtle">Invoice {b.vendorInvoiceNumber}</p>
                    </td>
                    <td className="py-1 pr-2">{formatDate(b.billDate)} → {formatDate(b.dueDate)}</td>
                    <td className="py-1 pr-2 text-right">{formatMoney(b.outstanding)}</td>
                    <td className="py-1">
                      <Input
                        type="number"
                        min="0"
                        max={b.outstanding}
                        step="0.01"
                        value={allocations[b.id] ?? ""}
                        onChange={(e) => setAllocations((a) => ({ ...a, [b.id]: e.target.value }))}
                        aria-label={`Allocation for ${b.number}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={`mt-2 text-sm ${unallocated < 0 ? "text-danger" : "text-muted"}`}>
          Allocated {formatMoney(allocated)} · Unallocated {formatMoney(unallocated)}
          {unallocated > 0 ? " (kept as an advance)" : ""}
        </p>
      </div>

      <Field label="Notes"><Textarea name="notes" rows={2} /></Field>
      {errors.length > 0 ? (
        <ul className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      ) : null}
      <Button type="submit" size="sm" disabled={pending || !vendorId || banks.length === 0}>{pending ? "Saving…" : "Record payment"}</Button>
    </form>
  );
}
