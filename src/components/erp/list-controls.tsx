import Link from "next/link";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

type SearchParams = Record<string, string | string[] | undefined>;

export function param(params: SearchParams, key: string) {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Plain GET form: search box + optional selects; keeps other params via hidden inputs. */
export function ListToolbar({
  params,
  filters = [],
  placeholder = "Search…",
  children,
}: {
  params: SearchParams;
  filters?: { name: string; label: string; options: { value: string; label: string }[] }[];
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
      <Input name="q" defaultValue={param(params, "q") ?? ""} placeholder={placeholder} className="max-w-xs" />
      {filters.map((f) => (
        <Select key={f.name} name={f.name} defaultValue={param(params, f.name) ?? ""} className="max-w-[200px]" aria-label={f.label}>
          <option value="">{f.label}: all</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ))}
      <Button type="submit" size="sm" variant="secondary">
        Apply
      </Button>
      {children}
    </form>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  params,
  basePath,
}: {
  page: number;
  pageSize: number;
  total: number;
  params: SearchParams;
  basePath: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (typeof v === "string" && k !== "page") search.set(k, v);
    search.set("page", String(p));
    return `${basePath}?${search.toString()}`;
  };
  return (
    <div className="mt-4 flex items-center justify-between text-xs text-muted">
      <span>
        {total === 0 ? "No results" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
      </span>
      <div className="flex gap-2">
        {page > 1 ? <Link className="rounded-lg border border-[var(--ic-border)] px-3 py-1" href={href(page - 1)}>Previous</Link> : null}
        {page < pages ? <Link className="rounded-lg border border-[var(--ic-border)] px-3 py-1" href={href(page + 1)}>Next</Link> : null}
      </div>
    </div>
  );
}

/** Server-side list params as the API expects them. */
export function listParams(params: SearchParams, extra: string[] = []) {
  const out: Record<string, string> = {};
  for (const key of ["q", "page", "pageSize", "sort", "dir", ...extra]) {
    const value = param(params, key);
    if (value) out[key] = value;
  }
  return out;
}
