import { Card, CardContent } from "@/components/ui/card";
import { formatMoney, humanize } from "@/components/erp/format";

type MetricView = {
  key: string;
  label: string;
  unit: string;
  definition: string;
  statusInclusion: string;
  dateField: string;
  aggregation: string;
  currency: string;
  value: unknown;
};

const isMoney = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, x]) => /^[A-Z]{3}$/.test(k) && typeof x === "string");

function Scalar({ value, unit }: { value: unknown; unit: string }) {
  if (value === null || value === undefined) return <>—</>;
  if (isMoney(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return <>—</>;
    return <>{entries.map(([ccy, v]) => <span key={ccy} className="block">{formatMoney(v, ccy)}</span>)}</>;
  }
  if (unit === "percent") return <>{String(value)}%</>;
  if (unit === "hours") return <>{String(value)} h</>;
  return <>{String(value)}</>;
}

/** Arrays of rows → small table; plain objects → key/value list (values may be money maps). */
function Breakdown({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (!value.length) return <p className="text-sm text-muted">Nothing in this period.</p>;
    const cols = Object.keys(value[0] as object).filter((k) => !k.endsWith("Id"));
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
            <tr>{cols.map((c) => <th key={c} className="py-1 pr-2">{humanize(c.replace(/([A-Z])/g, "_$1"))}</th>)}</tr>
          </thead>
          <tbody>
            {value.map((row, i) => (
              <tr key={i} className="border-t border-[var(--ic-border)]">
                {cols.map((c) => <td key={c} className="py-1 pr-2">{String((row as Record<string, unknown>)[c] ?? "—")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const entries = Object.entries((value ?? {}) as Record<string, unknown>);
  if (!entries.length) return <p className="text-sm text-muted">Nothing in this period.</p>;
  return (
    <dl className="space-y-1 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2">
          <dt>{humanize(k)}</dt>
          <dd className="text-right font-medium"><Scalar value={v} unit="" /></dd>
        </div>
      ))}
    </dl>
  );
}

export function MetricCard({ metric }: { metric: MetricView }) {
  const wide = metric.unit === "breakdown";
  return (
    <Card className={wide ? "sm:col-span-2" : undefined}>
      <CardContent className="space-y-2 pt-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-subtle">{metric.label}</p>
          <details className="relative text-2xs">
            <summary className="cursor-pointer list-none rounded-full border border-[var(--ic-border)] px-1.5 text-subtle" aria-label={`How "${metric.label}" is calculated`}>?</summary>
            <div className="absolute right-0 z-10 mt-1 w-72 space-y-1 rounded-lg border border-[var(--ic-border)] bg-surface p-3 text-xs shadow-card">
              <p>{metric.definition}</p>
              <p><span className="font-medium">Included:</span> {metric.statusInclusion}</p>
              <p><span className="font-medium">Date:</span> {metric.dateField}</p>
              <p><span className="font-medium">Aggregation:</span> {metric.aggregation}</p>
              <p><span className="font-medium">Currency:</span> {metric.currency}</p>
            </div>
          </details>
        </div>
        {wide ? <Breakdown value={metric.value} /> : <p className="text-xl font-semibold"><Scalar value={metric.value} unit={metric.unit} /></p>}
      </CardContent>
    </Card>
  );
}
