"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { formatDate, humanize } from "@/components/erp/format";

type Suggestion = {
  id: string;
  description: string | null;
  entry: { id: string; number: string | null; date: string; sourceType: string; memo: string | null };
};

/** Loads ledger lines that could match a statement line (same amount, ±10 days) and reconciles one. */
export function ReconcileRow({ transactionId }: { transactionId: string }) {
  const router = useRouter();
  const [matches, setMatches] = useState<Suggestion[] | null>(null);
  const [pending, setPending] = useState(false);

  async function run<T>(fn: () => Promise<T>) {
    setPending(true);
    try {
      return await fn();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  const load = () => run(async () => setMatches(await apiFetch<Suggestion[]>(`/bank-transactions/${transactionId}/matches`)));
  const reconcile = (journalLineId: string) =>
    run(async () => {
      await apiFetch(`/bank-transactions/${transactionId}/reconcile`, { method: "POST", body: { journalLineId } });
      toast.success("Reconciled");
      router.refresh();
    });

  if (!matches) {
    return <Button type="button" size="sm" variant="secondary" onClick={load} disabled={pending}>{pending ? "Loading…" : "Find matches"}</Button>;
  }
  if (matches.length === 0) return <p className="text-xs text-muted">No ledger line with this amount within 10 days.</p>;
  return (
    <ul className="space-y-1">
      {matches.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center gap-2 text-xs">
          <span>
            <span className="font-medium">{m.entry.number ?? "Draft"}</span> · {formatDate(m.entry.date)} · {humanize(m.entry.sourceType)}
            {m.entry.memo ? <span className="block text-subtle">{m.entry.memo}</span> : null}
          </span>
          <Button type="button" size="sm" onClick={() => reconcile(m.id)} disabled={pending}>Match</Button>
        </li>
      ))}
    </ul>
  );
}
