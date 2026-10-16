"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";

const DATE_FORMATS = ["DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD", "MM/DD/YYYY"] as const;
type ColumnKey = "date" | "description" | "amount" | "debit" | "credit" | "reference";
const COLUMNS: { key: ColumnKey; label: string; guess: RegExp }[] = [
  { key: "date", label: "Date", guess: /date/i },
  { key: "description", label: "Description", guess: /desc|narration|particular|remark/i },
  { key: "amount", label: "Amount (+ in / − out)", guess: /^amount$/i },
  { key: "debit", label: "Debit / withdrawal", guess: /debit|withdraw/i },
  { key: "credit", label: "Credit / deposit", guess: /credit|deposit/i },
  { key: "reference", label: "Reference", guess: /ref|cheque|chq|utr/i },
];
type Result = { imported: number; duplicates: number; errors: { row: number; message: string }[] };

export function BankImportForm({ bankAccountId }: { bankAccountId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [columns, setColumns] = useState<Partial<Record<ColumnKey, string>>>({});
  const [dateFormat, setDateFormat] = useState<(typeof DATE_FORMATS)[number]>("DD/MM/YYYY");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const f = event.target.files?.[0];
    setResult(null);
    if (!f) return;
    const text = await f.text();
    const header = (Papa.parse<string[]>(text, { preview: 1 }).data[0] ?? []).map((h) => h.trim()).filter(Boolean);
    setFile({ name: f.name, text });
    setHeaders(header);
    setColumns(Object.fromEntries(COLUMNS.map((c) => [c.key, header.find((h) => c.guess.test(h)) ?? ""])));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setPending(true);
    try {
      const mapped = Object.fromEntries(Object.entries(columns).filter(([, v]) => v));
      const data = await apiFetch<Result>(`/bank-accounts/${bankAccountId}/imports`, { method: "POST", body: { fileName: file.name, csv: file.text, columns: mapped, dateFormat } });
      setResult(data);
      toast.success(`Imported ${data.imported} statement lines`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Import failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Field label="Statement CSV" hint="Export the statement from your bank's website as CSV. The first row must be the column headers.">
        <Input type="file" accept=".csv,text/csv" onChange={onFile} required />
      </Field>
      {file ? (
        headers.length === 0 ? (
          <p className="text-sm text-danger">No header row found in {file.name}.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {COLUMNS.map((c) => (
                <Field key={c.key} label={c.label}>
                  <Select value={columns[c.key] ?? ""} onChange={(e) => setColumns((cs) => ({ ...cs, [c.key]: e.target.value }))} required={c.key === "date" || c.key === "description"}>
                    <option value="">—</option>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </Select>
                </Field>
              ))}
              <Field label="Date format">
                <Select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as (typeof DATE_FORMATS)[number])}>
                  {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                </Select>
              </Field>
            </div>
            <p className="text-2xs text-subtle">Map either an amount column, or both debit and credit columns. Rows already imported are skipped.</p>
            <Button type="submit" size="sm" disabled={pending}>{pending ? "Importing…" : "Import statement"}</Button>
          </>
        )
      ) : null}
      {result ? (
        <div className="rounded-xl bg-[var(--ic-surface-muted)] px-3 py-2 text-sm">
          <p>{result.imported} imported · {result.duplicates} duplicates skipped · {result.errors.length} rows with errors</p>
          {result.errors.length ? (
            <ul className="mt-1 text-xs text-danger">
              {result.errors.slice(0, 20).map((e) => <li key={e.row}>Row {e.row}: {e.message}</li>)}
              {result.errors.length > 20 ? <li>…and {result.errors.length - 20} more</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
