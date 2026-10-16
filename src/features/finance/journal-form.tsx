"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";
import { formatMoney } from "@/components/erp/format";

export type JournalAccountOption = { id: string; code: string; name: string };
type Line = { accountId: string; debit: string; credit: string; description: string };

const blank = (): Line => ({ accountId: "", debit: "", credit: "", description: "" });
/** Sum in paise so 0.1 + 0.2 adds up exactly. */
const paise = (lines: Line[], key: "debit" | "credit") => lines.reduce((s, l) => s + Math.round((Number(l[key]) || 0) * 100), 0);

export function JournalForm({ companyId, accounts, defaultDate }: { companyId: string; accounts: JournalAccountOption[]; defaultDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const debit = paise(lines, "debit");
  const credit = paise(lines, "credit");
  const diff = debit - credit;
  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrors([]);
    try {
      const body = {
        companyId,
        date,
        memo,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          ...(l.debit ? { debit: l.debit } : {}),
          ...(l.credit ? { credit: l.credit } : {}),
          ...(l.description.trim() ? { description: l.description.trim() } : {}),
        })),
      };
      const data = await apiFetch<{ id: string }>("/journals", { method: "POST", body });
      toast.success("Draft journal saved");
      router.push(`/finance/journals/${data.id}`);
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors((error.details ?? []).map((d) => `${d.path !== undefined ? `${String(d.path)}: ` : ""}${String(d.message)}`));
        toast.error(error.message);
      } else toast.error("Something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label="Memo" className="sm:col-span-2"><Input value={memo} onChange={(e) => setMemo(e.target.value)} required maxLength={500} placeholder="e.g. Opening balances" /></Field>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
            <tr className="border-b border-[var(--ic-border)]">
              <th className="py-2 pr-2">Account</th>
              <th className="py-2 pr-2">Description</th>
              <th className="w-36 py-2 pr-2 text-right">Debit</th>
              <th className="w-36 py-2 pr-2 text-right">Credit</th>
              <th className="w-10 py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-[var(--ic-border)] last:border-0">
                <td className="py-2 pr-2">
                  <Select value={l.accountId} onChange={(e) => update(i, { accountId: e.target.value })} required aria-label={`Line ${i + 1} account`}>
                    <option value="">Choose account…</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                  </Select>
                </td>
                <td className="py-2 pr-2"><Input value={l.description} onChange={(e) => update(i, { description: e.target.value })} aria-label={`Line ${i + 1} description`} /></td>
                <td className="py-2 pr-2">
                  <Input type="number" step="0.01" min="0" value={l.debit} onChange={(e) => update(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} className="text-right" aria-label={`Line ${i + 1} debit`} />
                </td>
                <td className="py-2 pr-2">
                  <Input type="number" step="0.01" min="0" value={l.credit} onChange={(e) => update(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} className="text-right" aria-label={`Line ${i + 1} credit`} />
                </td>
                <td className="py-2 text-right">
                  {lines.length > 2 ? (
                    <Button type="button" size="icon-sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>×</Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="py-2 pr-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => setLines((ls) => [...ls, blank()])}>Add line</Button>
              </td>
              <td className="py-2 pr-2 text-right text-muted">Totals</td>
              <td className="py-2 pr-2 text-right">{formatMoney(debit / 100)}</td>
              <td className="py-2 pr-2 text-right">{formatMoney(credit / 100)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className={diff === 0 && debit > 0 ? "text-sm text-success" : "text-sm text-warning"} aria-live="polite">
        {debit === 0 && credit === 0
          ? "Enter debit and credit amounts."
          : diff === 0
            ? "Balanced."
            : `Out of balance by ${formatMoney(Math.abs(diff) / 100)} (${diff > 0 ? "more debits" : "more credits"}). You can save a draft, but it can only be posted once balanced.`}
      </p>

      {errors.length ? (
        <ul className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      ) : null}

      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save draft"}</Button>
    </form>
  );
}
