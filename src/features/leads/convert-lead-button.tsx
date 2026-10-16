"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";

type Match = { id: string; name: string; gstin: string | null; email: string | null; phone: string | null; matchedOn: string[] };
type Result = { leadId: string; customerId: string; contactId: string | null; opportunityId: string | null; alreadyConverted: boolean };

export function ConvertLeadButton({ leadId, convertedCustomerId }: { leadId: string; convertedCustomerId: string | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [matches, setMatches] = useState<Match[] | null>(null);

  if (convertedCustomerId) {
    return (
      <Link href={`/crm/customers/${convertedCustomerId}`} className="text-sm font-medium text-primary hover:underline">
        View customer
      </Link>
    );
  }

  async function convert(body: { customerId?: string; ignoreDuplicates?: boolean }) {
    setPending(true);
    try {
      const result = await apiFetch<Result>(`/leads/${leadId}/convert`, { method: "POST", body });
      toast.success(result.alreadyConverted ? "Lead was already converted" : "Lead converted to customer");
      router.push(`/crm/customers/${result.customerId}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "DUPLICATE") {
        setMatches((error.details ?? []) as Match[]);
      } else {
        toast.error(error instanceof ApiError ? error.message : "Conversion failed");
      }
    } finally {
      setPending(false);
    }
  }

  if (!matches) {
    return (
      <Button type="button" size="sm" onClick={() => convert({})} disabled={pending}>
        {pending ? "Converting…" : "Convert to customer"}
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl border border-[var(--ic-border)] bg-[var(--ic-surface-muted)] p-3 text-sm">
      <p className="font-medium">Possible existing customers. Link the lead to one, or create a new customer anyway.</p>
      <ul className="space-y-2">
        {matches.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2">
            <Link href={`/crm/customers/${m.id}`} target="_blank" className="font-medium text-primary hover:underline">{m.name}</Link>
            <span className="text-xs text-muted">{[m.gstin, m.email, m.phone].filter(Boolean).join(" · ")}</span>
            <span className="text-2xs text-subtle">same {m.matchedOn.join(", ")}</span>
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => convert({ customerId: m.id })}>
              Link to this customer
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => convert({ ignoreDuplicates: true })}>
          Create new customer anyway
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setMatches(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
