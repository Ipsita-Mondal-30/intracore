"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

type Result = {
  jobId: string | null;
  dryRun: boolean;
  totalRows: number;
  imported: number;
  duplicates: number;
  errors: number;
  failedRows: { row: number; kind: string; reason: string }[];
};

const MAX_BYTES = 5 * 1024 * 1024;

/** Pick entity + CSV, validate (dry run), then import. The CSV is sent as text in a JSON body. */
export function ImportPanel({ entities }: { entities: string[] }) {
  const router = useRouter();
  const [entity, setEntity] = useState(entities[0] ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);

  async function run(dryRun: boolean) {
    if (!file) return toast.error("Choose a CSV file first");
    if (file.size > MAX_BYTES) return toast.error("The file is larger than 5 MB");
    if (!dryRun && !window.confirm(`Import ${file.name} as ${entity} records?`)) return;
    setPending(true);
    try {
      const data = await apiFetch<Result>("/admin/imports", {
        method: "POST",
        body: { entity, csv: await file.text(), filename: file.name, dryRun },
      });
      setResult(data);
      toast.success(dryRun ? "Validation finished: nothing was written" : `Imported ${data.imported} records`);
      if (!dryRun) router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        const details = (error.details ?? []).map((d) => `${d.path}: ${d.message}`).join("; ");
        toast.error(details ? `${error.message} (${details})` : error.message);
      } else toast.error("Something went wrong");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={entity} onChange={(e) => { setEntity(e.target.value); setResult(null); }} className="max-w-[180px]" aria-label="Record type">
          {entities.map((e) => <option key={e} value={e}>{e}</option>)}
        </Select>
        <a className="text-sm text-primary underline" href={`/api/v1/admin/imports/template?entity=${entity}`}>Download {entity} template</a>
      </div>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} className="block text-sm" />
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={pending || !file} onClick={() => run(true)}>{pending ? "Working…" : "Validate (dry run)"}</Button>
        <Button type="button" size="sm" disabled={pending || !file || !result?.dryRun} onClick={() => run(false)}>Import</Button>
      </div>
      {result ? (
        <div className="rounded-xl bg-[var(--ic-surface-muted)] p-3 text-sm">
          <p className="font-medium">
            {result.dryRun ? "Dry run" : "Imported"}: {result.totalRows} rows · {result.imported} {result.dryRun ? "would be created" : "created"} · {result.duplicates} duplicates skipped · {result.errors} errors
          </p>
          {result.failedRows.length ? (
            <ul className="mt-2 max-h-72 space-y-1 overflow-auto text-xs">
              {result.failedRows.map((f) => (
                <li key={`${f.row}-${f.kind}`}><strong>Row {f.row}</strong> ({f.kind}): {f.reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
