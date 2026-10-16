"use client";

import { Input } from "@/components/ui/input";
import { Field } from "@/components/erp/api-form";
import { PortalForm } from "@/app/portal/_components/portal-client";

export function SubmitInvoiceForm({ purchaseOrderId, lines }: { purchaseOrderId: string; lines: { id: string; label: string; open: number }[] }) {
  return (
    <PortalForm
      path="/vendor/bills"
      submitLabel="Submit invoice"
      successMessage="Invoice submitted"
      redirect="/portal/vendor"
      transform={(v) => ({
        purchaseOrderId,
        vendorInvoiceNumber: v.vendorInvoiceNumber,
        billDate: v.billDate,
        dueDate: v.dueDate,
        remarks: v.remarks,
        lines: lines
          .map((l) => ({ purchaseOrderLineId: l.id, quantity: v[`qty_${l.id}`], unitPrice: v[`price_${l.id}`] }))
          .filter((l) => l.quantity),
      })}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Invoice number"><Input name="vendorInvoiceNumber" required maxLength={64} /></Field>
        <Field label="Invoice date"><Input name="billDate" type="date" required /></Field>
        <Field label="Due date"><Input name="dueDate" type="date" /></Field>
      </div>
      {lines.map((l) => (
        <div key={l.id} className="grid items-end gap-3 sm:grid-cols-[1fr_140px_140px]">
          <p className="text-sm">{l.label} <span className="text-2xs text-subtle">(received, not yet invoiced: {l.open})</span></p>
          <Input name={`qty_${l.id}`} inputMode="decimal" placeholder="Quantity" aria-label="Quantity" />
          <Input name={`price_${l.id}`} inputMode="decimal" placeholder="Rate (blank = PO rate)" aria-label="Rate" />
        </div>
      ))}
      <Field label="Remarks"><Input name="remarks" maxLength={2000} /></Field>
    </PortalForm>
  );
}
