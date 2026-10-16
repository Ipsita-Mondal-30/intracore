"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import type { OrgSettings } from "@/lib/settings";

type Rules = OrgSettings["duplicates"];

const OPTIONS: { [K in keyof Rules]: { label: string; fields: { value: Rules[K][number]; label: string }[] } } = {
  customer: {
    label: "Customers",
    fields: [
      { value: "gstin", label: "GSTIN" },
      { value: "email", label: "Email" },
      { value: "phone", label: "Phone (last 10 digits)" },
      { value: "name", label: "Name" },
    ],
  },
  lead: {
    label: "Leads",
    fields: [
      { value: "email", label: "Email" },
      { value: "phone", label: "Phone" },
      { value: "whatsapp", label: "WhatsApp" },
      { value: "company", label: "Company" },
    ],
  },
};

export function DuplicateRulesForm({ rules, canEdit }: { rules: Rules; canEdit: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    try {
      await apiFetch("/crm/settings", {
        method: "PUT",
        body: { duplicates: { customer: data.getAll("customer"), lead: data.getAll("lead") } },
      });
      toast.success("Duplicate rules saved");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {(Object.keys(OPTIONS) as (keyof Rules)[]).map((kind) => (
        <fieldset key={kind} disabled={!canEdit} className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{OPTIONS[kind].label}: flag a possible duplicate when these match</legend>
          <div className="flex flex-wrap gap-4">
            {OPTIONS[kind].fields.map((f) => (
              <label key={f.value} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={kind} value={f.value} defaultChecked={(rules[kind] as string[]).includes(f.value)} />
                {f.label}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {canEdit ? (
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save rules"}</Button>
      ) : (
        <p className="text-xs text-muted">You need the CRM administer permission to change these rules.</p>
      )}
    </form>
  );
}
