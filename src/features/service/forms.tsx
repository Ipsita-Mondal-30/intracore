"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";

type Option = { id: string; label: string };

async function submit(path: string, method: "POST" | "PATCH", body: unknown, onDone: (id?: string) => void) {
  try {
    const data = await apiFetch<{ id?: string }>(path, { method, body });
    toast.success("Saved");
    onDone(data?.id);
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : "Something went wrong");
  }
}

/**
 * New AMC contract (or edit of a draft): header, covered assets of the chosen customer,
 * and entitlement rows (blank quantity = unlimited).
 */
export function ContractForm({
  companies,
  customers,
  assets,
  initial,
}: {
  companies: Option[];
  customers: Option[];
  assets: (Option & { customerId: string | null })[];
  initial?: { id: string; customerId: string; startDate: string; endDate: string; value: string; terms: string; assetIds: string[]; entitlements: { serviceType: string; quantity: string }[] };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [customerId, setCustomerId] = useState(initial?.customerId ?? customers[0]?.id ?? "");
  const [picked, setPicked] = useState<string[]>(initial?.assetIds ?? []);
  const [rows, setRows] = useState(initial?.entitlements.length ? initial.entitlements : [{ serviceType: "PREVENTIVE", quantity: "4" }]);
  const owned = assets.filter((a) => a.customerId === customerId);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const body = {
      ...(initial ? {} : { companyId: f.get("companyId"), customerId }),
      startDate: f.get("startDate"),
      endDate: f.get("endDate"),
      value: f.get("value"),
      terms: f.get("terms") || null,
      assetIds: picked.filter((id) => owned.some((a) => a.id === id)),
      entitlements: rows.filter((r) => r.serviceType.trim()).map((r) => ({ serviceType: r.serviceType, quantity: r.quantity ? Number(r.quantity) : null })),
    };
    setPending(true);
    await submit(initial ? `/service-contracts/${initial.id}` : "/service-contracts", initial ? "PATCH" : "POST", body, (id) =>
      initial ? router.refresh() : router.push(`/service/contracts/${id}`),
    );
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {initial ? null : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company">
            <Select name="companyId" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
          </Field>
          <Field label="Customer">
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Start"><Input type="date" name="startDate" defaultValue={initial?.startDate} required /></Field>
        <Field label="End"><Input type="date" name="endDate" defaultValue={initial?.endDate} required /></Field>
        <Field label="Contract value"><Input name="value" inputMode="decimal" defaultValue={initial?.value} required /></Field>
      </div>
      <fieldset className="text-sm">
        <legend className="mb-1.5 font-medium">Covered assets</legend>
        {owned.length === 0 ? <p className="text-muted">This customer has no registered assets.</p> : null}
        <div className="grid gap-1 sm:grid-cols-2">
          {owned.map((a) => (
            <label key={a.id} className="flex items-center gap-2">
              <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} />
              {a.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2 text-sm">
        <legend className="mb-1.5 font-medium">Entitlements</legend>
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label="Service type" placeholder="Service type (e.g. PREVENTIVE)" value={r.serviceType} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, serviceType: e.target.value } : x)))} />
            <Input aria-label="Included quantity" placeholder="Qty (blank = unlimited)" type="number" min={1} value={r.quantity} className="max-w-[180px]" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            <Button type="button" size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={() => setRows([...rows, { serviceType: "", quantity: "" }])}>Add entitlement</Button>
      </fieldset>
      <Field label="Terms"><Textarea name="terms" rows={3} defaultValue={initial?.terms} /></Field>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : initial ? "Save draft" : "Create contract"}</Button>
    </form>
  );
}

/** New installation job with a checklist (one item per line; prefix "?" for optional). */
export function InstallationForm({ companies, customers, technicians }: { companies: Option[]; customers: Option[]; technicians: Option[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const value = (k: string) => (f.get(k) ? String(f.get(k)) : null);
    const iso = (k: string) => (value(k) ? new Date(value(k)!).toISOString() : null);
    const body = {
      companyId: value("companyId"),
      customerId: value("customerId"),
      address: value("address"),
      technicianId: value("technicianId"),
      scheduledStart: iso("scheduledStart"),
      scheduledEnd: iso("scheduledEnd"),
      notes: value("notes"),
      checklist: String(f.get("checklist") ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.startsWith("?") ? { label: l.slice(1).trim(), required: false } : { label: l, required: true })),
    };
    setPending(true);
    await submit("/installation-jobs", "POST", body, (id) => router.push(`/service/installations/${id}`));
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company"><Select name="companyId" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
        <Field label="Customer"><Select name="customerId" required>{customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
        <Field label="Technician">
          <Select name="technicianId"><option value="">Assign later</option>{technicians.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select>
        </Field>
        <Field label="Site address"><Input name="address" maxLength={1000} /></Field>
        <Field label="Start"><Input type="datetime-local" name="scheduledStart" /></Field>
        <Field label="End"><Input type="datetime-local" name="scheduledEnd" /></Field>
      </div>
      <Field label="Checklist" hint={'One item per line. Start a line with "?" to make it optional.'}>
        <Textarea name="checklist" rows={4} placeholder={"Unpack and inspect\nMount unit\nCommission and test\n?Site photo"} />
      </Field>
      <Field label="Notes"><Textarea name="notes" rows={2} /></Field>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Create job"}</Button>
    </form>
  );
}
