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

export type ExpenseLineInput = { categoryId: string; expenseDate: string; description: string; amount: string; taxAmount: string };
export type ExpenseCategoryOption = { id: string; companyId: string; name: string };

/**
 * Create a claim (POST, company selectable) or edit one (PATCH, company fixed).
 * Categories are passed for every accessible company and filtered by the chosen one.
 */
export function ExpenseClaimForm({
  companies,
  categories,
  today,
  initial,
}: {
  companies: { id: string; label: string }[];
  categories: ExpenseCategoryOption[];
  today: string;
  initial?: { id: string; companyId: string; title: string; lines: ExpenseLineInput[] };
}) {
  const router = useRouter();
  const blank = (): ExpenseLineInput => ({ categoryId: "", expenseDate: today, description: "", amount: "", taxAmount: "0" });
  const [companyId, setCompanyId] = useState(initial?.companyId ?? companies[0]?.id ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [lines, setLines] = useState<ExpenseLineInput[]>(initial?.lines ?? [blank()]);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const options = categories.filter((c) => c.companyId === companyId);
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const update = (i: number, patch: Partial<ExpenseLineInput>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrors([]);
    try {
      const body = { title, lines: lines.map((l) => ({ ...l, description: l.description.trim() })) };
      if (initial) {
        await apiFetch(`/expense-claims/${initial.id}`, { method: "PATCH", body });
        toast.success("Claim updated");
        router.refresh();
      } else {
        const claim = await apiFetch<{ id: string }>("/expense-claims", { method: "POST", body: { companyId, ...body } });
        toast.success("Claim created");
        router.push(`/finance/expenses/${claim.id}`);
      }
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
        {initial ? null : (
          <Field label="Company">
            <Select
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                setLines((ls) => ls.map((l) => ({ ...l, categoryId: "" })));
              }}
              required
            >
              {companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Title" className="sm:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Client visit, Pune" />
        </Field>
      </div>

      {options.length === 0 ? (
        <p className="text-sm text-muted">This company has no expense categories yet. Ask a finance administrator to set them up.</p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
            <tr>
              <th className="w-48 py-1 pr-2">Category</th>
              <th className="w-40 py-1 pr-2">Date</th>
              <th className="py-1 pr-2">Description</th>
              <th className="w-36 py-1 pr-2">Amount</th>
              <th className="w-10 py-1" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="align-top">
                <td className="py-1 pr-2">
                  <Select value={l.categoryId} onChange={(e) => update(i, { categoryId: e.target.value })} required aria-label="Category">
                    <option value="">Select…</option>
                    {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </td>
                <td className="py-1 pr-2">
                  <Input type="date" value={l.expenseDate} onChange={(e) => update(i, { expenseDate: e.target.value })} required aria-label="Expense date" />
                </td>
                <td className="py-1 pr-2">
                  <Input value={l.description} onChange={(e) => update(i, { description: e.target.value })} required maxLength={500} aria-label="Description" />
                </td>
                <td className="py-1 pr-2">
                  <Input type="number" min="0.01" step="0.01" value={l.amount} onChange={(e) => update(i, { amount: e.target.value })} required aria-label="Amount" />
                </td>
                <td className="py-1">
                  {lines.length > 1 ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">×</Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => setLines((ls) => [...ls, blank()])}>Add expense</Button>
        <p className="text-sm font-semibold">Total {formatMoney(total)}</p>
      </div>
      {errors.length > 0 ? (
        <ul className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      ) : null}
      <Button type="submit" size="sm" disabled={pending || options.length === 0}>{pending ? "Saving…" : initial ? "Save changes" : "Create claim"}</Button>
    </form>
  );
}
