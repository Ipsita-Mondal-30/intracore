"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";

type Props = {
  customers: { id: string; name: string; isDealer: boolean }[];
  vendors: { id: string; name: string }[];
  employees: { id: string; fullName: string; employeeNumber: string }[];
};

const KINDS = [
  ["CUSTOMER", "Customer"],
  ["DEALER", "Dealer"],
  ["VENDOR", "Supplier"],
  ["EMPLOYEE", "Employee self-service"],
  ["TECHNICIAN", "Technician (must be a member)"],
] as const;

/** Shows the accept URL once after inviting: it is not stored and cannot be shown again. */
export function InviteForm({ customers, vendors, employees }: Props) {
  const router = useRouter();
  const [kind, setKind] = useState<string>("CUSTOMER");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ acceptUrl: string; emailSent: boolean } | null>(null);

  const partyField =
    kind === "CUSTOMER" || kind === "DEALER"
      ? { name: "customerId", label: kind === "DEALER" ? "Dealer" : "Customer", items: customers.filter((c) => kind !== "DEALER" || c.isDealer).map((c) => [c.id, c.name]) }
      : kind === "VENDOR"
        ? { name: "vendorId", label: "Supplier", items: vendors.map((v) => [v.id, v.name]) }
        : kind === "EMPLOYEE"
          ? { name: "employeeId", label: "Employee", items: employees.map((e) => [e.id, `${e.fullName} (${e.employeeNumber})`]) }
          : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    try {
      const data = await apiFetch<{ acceptUrl: string; emailSent: boolean }>("/portal-invitations", { method: "POST", body: Object.fromEntries(form) });
      setResult(data);
      toast.success(data.emailSent ? "Invitation emailed" : "Invitation created");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Invite failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="grid items-end gap-3 sm:grid-cols-4">
        <Field label="Email"><Input name="email" type="email" required /></Field>
        <Field label="Portal">
          <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        {partyField ? (
          <Field label={partyField.label}>
            <Select name={partyField.name} required key={partyField.name + kind}>
              <option value="">Choose…</option>
              {partyField.items.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </Select>
          </Field>
        ) : <div />}
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Inviting…" : "Invite"}</Button>
      </form>
      {result ? (
        <div className="rounded-xl bg-[var(--ic-table-header)] p-3 text-sm">
          <p className="mb-1 font-medium">{result.emailSent ? "Email sent. " : "Email is not configured; send this link yourself. "}It is shown only once:</p>
          <code className="break-all text-xs">{result.acceptUrl}</code>
        </div>
      ) : null}
    </div>
  );
}
