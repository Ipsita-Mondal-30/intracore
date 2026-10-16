"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";
import { PortalForm } from "@/app/portal/_components/portal-client";

/** Lines are sent as product + quantity only: price, discount and tax are set by the server. */
export function OrderRequestForm({ products }: { products: { id: string; label: string }[] }) {
  const [rows, setRows] = useState(1);
  return (
    <PortalForm
      path="/dealer/order-requests"
      submitLabel="Send request"
      successMessage="Request sent"
      transform={(v) => ({
        customerPoNumber: v.customerPoNumber,
        remarks: v.remarks,
        lines: Array.from({ length: rows }, (_, i) => ({ productId: v[`product${i}`], quantity: v[`qty${i}`] })).filter((l) => l.productId && l.quantity),
      })}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid gap-3 sm:grid-cols-[1fr_140px]">
          <Select name={`product${i}`} defaultValue="" aria-label="Product">
            <option value="">Choose a product</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
          <Input name={`qty${i}`} type="text" inputMode="decimal" placeholder="Quantity" aria-label="Quantity" />
        </div>
      ))}
      <Button type="button" size="sm" variant="secondary" onClick={() => setRows((n) => n + 1)}>Add line</Button>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Your PO number"><Input name="customerPoNumber" maxLength={64} /></Field>
        <Field label="Remarks"><Input name="remarks" maxLength={2000} /></Field>
      </div>
    </PortalForm>
  );
}
