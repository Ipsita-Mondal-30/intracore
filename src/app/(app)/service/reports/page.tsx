import { can, getAccessContext } from "@/lib/access";
import { serviceReport } from "@/features/service/ticket-reports";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { param } from "@/components/erp/list-controls";
import { dateInput, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const fmt = (n: number | null, suffix = "") => (n === null ? "—" : `${n}${suffix}`);

export default async function ServiceReportsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Service", "Reports"]} title="Service reports" subtitle="Backlog, SLA performance and technician workload." />;
  if (!can(ctx, "ticket.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view tickets.</p></div>;
  }
  const valid = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? v : undefined);
  const r = await serviceReport(ctx, { from: valid(param(params, "from")), to: valid(param(params, "to")) });
  const tiles: [string, string][] = [
    ["Open tickets", String(r.open.total)],
    ["Overdue", String(r.open.overdue)],
    ["Unassigned", String(r.open.unassigned)],
    ["Resolved in period", String(r.resolved.count)],
    ["Avg resolution", fmt(r.resolved.avgResolutionHours, " h")],
    ["Resolution SLA breach", fmt(r.resolved.slaBreachRate, "%")],
    ["First response breach", fmt(r.firstResponse.breachRate, "%")],
    ["Avg rating", fmt(r.resolved.avgRating, " / 5")],
  ];

  return (
    <div className="space-y-4">
      {header}
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label>From <Input type="date" name="from" defaultValue={dateInput(r.period.from)} /></label>
        <label>To <Input type="date" name="to" defaultValue={dateInput(r.period.to)} /></label>
        <Button type="submit" size="sm" variant="secondary">Apply</Button>
      </form>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([label, value]) => (
          <Card key={label}><CardContent className="pt-5"><p className="text-2xs text-subtle">{label}</p><p className="text-xl font-semibold">{value}</p></CardContent></Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {([["Open by status", r.open.byStatus], ["Open by priority", r.open.byPriority]] as const).map(([title, data]) => (
          <Card key={title}>
            <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
            <CardContent>
              {Object.keys(data).length === 0 ? <p className="text-sm text-muted">Nothing open.</p> : (
                <dl className="space-y-1 text-sm">
                  {Object.entries(data).map(([k, v]) => <div key={k} className="flex justify-between"><dt>{humanize(k)}</dt><dd className="font-medium">{v}</dd></div>)}
                </dl>
              )}
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader><CardTitle>Technicians</CardTitle></CardHeader>
          <CardContent>
            {r.technicians.length === 0 ? <p className="text-sm text-muted">No assigned tickets.</p> : (
              <table className="w-full text-sm">
                <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                  <tr><th className="py-1">Technician</th><th className="py-1 text-right">Open</th><th className="py-1 text-right">Resolved</th><th className="py-1 text-right">Avg h</th></tr>
                </thead>
                <tbody>
                  {r.technicians.map((t) => (
                    <tr key={t.userId} className="border-t border-[var(--ic-border)]">
                      <td className="py-1">{t.user?.name ?? t.user?.email ?? "—"}</td>
                      <td className="py-1 text-right">{t.open}</td>
                      <td className="py-1 text-right">{t.resolved}</td>
                      <td className="py-1 text-right">{fmt(t.avgResolutionHours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
