"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";

export type ReceiptCompany = { id: string; label: string };
export type ReceiptBank = { id: string; companyId: string; label: string };
export type ReceiptInvoice = { id: string; companyId: string; number: string; dueDate: string; grandTotal: string; outstanding: string };

const METHODS = ["BANK_TRANSFER", "CASH", "CHEQUE", "UPI", "CARD", "OTHER"] as const;
const cents = (v: string) => Math.round(Number(v || 0) * 100);
const fmt = (c: number) => (c / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Records (and posts) a customer receipt, optionally allocated across open invoices. */
export function ReceiptForm({
  companies,
  customers,
  banks,
  invoices,
  customerId,
  defaultCompanyId,
  prefill,
}: {
  companies: ReceiptCompany[];
  customers: { id: string; name: string }[];
  banks: ReceiptBank[];
  invoices: ReceiptInvoice[];
  customerId: string;
  defaultCompanyId: string;
  prefill?: { invoiceId: string; amount: string };
}) {
  const router = useRouter();
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [bankAccountId, setBankAccountId] = useState(() => banks.find((b) => b.companyId === defaultCompanyId)?.id ?? "");
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [receiptDate, setReceiptDate] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [alloc, setAlloc] = useState<Record<string, string>>(() => (prefill ? { [prefill.invoiceId]: prefill.amount } : {}));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const companyBanks = banks.filter((b) => b.companyId === companyId);
  const companyInvoices = invoices.filter((i) => i.companyId === companyId);
  const allocated = companyInvoices.reduce((s, i) => s + cents(alloc[i.id] ?? ""), 0);
  const unallocated = cents(amount) - allocated;

  function pickCompany(id: string) {
    setCompanyId(id);
    setBankAccountId(banks.find((b) => b.companyId === id)?.id ?? "");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (unallocated < 0) {
      setError("Allocations exceed the amount received.");
      return;
    }
    const allocations = companyInvoices.flatMap((i) => (cents(alloc[i.id] ?? "") > 0 ? [{ invoiceId: i.id, amount: alloc[i.id] }] : []));
    setPending(true);
    setError("");
    try {
      const receipt = await apiFetch<{ id: string }>("/receipts", {
        method: "POST",
        body: {
          companyId,
          customerId,
          bankAccountId,
          amount,
          method,
          allocations,
          ...(receiptDate ? { receiptDate } : {}),
          ...(reference ? { reference } : {}),
          ...(notes ? { notes } : {}),
        },
      });
      toast.success("Receipt recorded");
      router.push(`/finance/receipts/${receipt.id}`);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Recording the receipt failed";
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Customer" hint="Changing the customer reloads their open invoices">
          <Select
            value={customerId}
            onChange={(e) => router.push(e.target.value ? `/finance/receipts/new?customerId=${e.target.value}` : "/finance/receipts/new")}
            required
          >
            <option value="">Select a customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Company">
          <Select value={companyId} onChange={(e) => pickCompany(e.target.value)} required>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Received into">
          <Select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} required>
            {companyBanks.length === 0 ? <option value="">No bank/cash account in this company</option> : null}
            {companyBanks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </Select>
        </Field>
        <Field label="Amount received">
          <Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <Field label="Receipt date" hint="Defaults to today">
          <Input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} />
        </Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}>
            {METHODS.map((m) => <option key={m} value={m}>{m.replace(/_/g, " ").toLowerCase()}</option>)}
          </Select>
        </Field>
        <Field label="Reference" hint="UTR, cheque number…">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Allocate to invoices</p>
        {!customerId ? (
          <p className="text-sm text-muted">Pick the customer first to see their open invoices.</p>
        ) : companyInvoices.length === 0 ? (
          <p className="text-sm text-muted">No posted invoices with a balance for this customer in this company. The whole amount will be recorded as on-account credit.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr>
                  <th className="py-1 pr-2">Invoice</th>
                  <th className="py-1 pr-2">Due</th>
                  <th className="py-1 pr-2 text-right">Total</th>
                  <th className="py-1 pr-2 text-right">Outstanding</th>
                  <th className="w-36 py-1">Allocate</th>
                </tr>
              </thead>
              <tbody>
                {companyInvoices.map((i) => (
                  <tr key={i.id}>
                    <td className="py-1 pr-2 font-medium">{i.number}</td>
                    <td className="py-1 pr-2">{i.dueDate}</td>
                    <td className="py-1 pr-2 text-right">{fmt(cents(i.grandTotal))}</td>
                    <td className="py-1 pr-2 text-right">{fmt(cents(i.outstanding))}</td>
                    <td className="py-1">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        max={i.outstanding}
                        value={alloc[i.id] ?? ""}
                        placeholder="0.00"
                        onChange={(e) => setAlloc((c) => ({ ...c, [i.id]: e.target.value }))}
                        aria-label={`Allocate to ${i.number}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={unallocated < 0 ? "text-sm text-danger" : "text-sm text-muted"}>
          Allocated {fmt(allocated)} · Unallocated {fmt(unallocated)}
          {unallocated > 0 ? " (kept as on-account credit for the customer)" : ""}
        </p>
      </div>

      <Button type="submit" size="sm" disabled={pending || !customerId || !bankAccountId || unallocated < 0}>
        {pending ? "Saving…" : "Record receipt"}
      </Button>
      {error ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p> : null}
    </form>
  );
}
