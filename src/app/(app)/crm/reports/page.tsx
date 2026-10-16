import { can, getAccessContext } from "@/lib/access";
import { getCrmFunnel } from "@/features/crm/reports";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { dateInput, formatDate, formatMoney } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

export default async function CrmReportsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();

  if (!can(ctx, "crm.report")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["CRM", "Reports"]} title="CRM reports" />
        <Card><CardContent className="pt-5 text-sm text-muted">You don&apos;t have access to CRM reports. Ask an administrator for the CRM report permission.</CardContent></Card>
      </div>
    );
  }

  const report = await getCrmFunnel(ctx, { from: param(params, "from") || undefined, to: param(params, "to") || undefined });
  const kpis = [
    { label: "Leads created", value: String(report.leads.created) },
    { label: "Leads converted", value: String(report.leads.converted) },
    { label: "Conversion rate", value: percent(report.leads.conversionRate) },
    { label: "Open pipeline", value: formatMoney(report.pipeline.openAmount) },
    { label: "Weighted pipeline", value: formatMoney(report.pipeline.weightedAmount) },
    { label: "Win rate", value: percent(report.deals.winRate), hint: `${report.deals.won} won · ${report.deals.lost} lost` },
    { label: "Average won deal", value: formatMoney(report.deals.averageWonDeal), hint: `${formatMoney(report.deals.wonAmount)} won` },
    { label: "Orders value", value: formatMoney(report.orders.amount), hint: `${report.orders.count} orders` },
  ];
  const quotations = Object.entries(report.quotations);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["CRM", "Reports"]}
        title="CRM reports"
        subtitle={`${formatDate(report.period.from)} – ${formatDate(report.period.to)}. Open pipeline is a current snapshot.`}
        actions={
          <form method="get" className="flex flex-wrap items-end gap-2">
            <Input type="date" name="from" defaultValue={dateInput(report.period.from)} aria-label="From" className="w-auto" />
            <Input type="date" name="to" defaultValue={dateInput(report.period.to)} aria-label="To" className="w-auto" />
            <Button type="submit" size="sm" variant="secondary">Apply</Button>
          </form>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="ic-card p-4">
            <p className="text-2xs text-subtle">{k.label}</p>
            <p className="text-lg font-semibold">{k.value}</p>
            {k.hint ? <p className="text-xs text-muted">{k.hint}</p> : null}
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Open pipeline by stage</CardTitle></CardHeader>
          <CardContent>
            <RecordsTable
              columns={[
                { key: "stage", label: "Stage" },
                { key: "count", label: "Deals" },
                { key: "amount", label: "Amount" },
                { key: "weighted", label: "Weighted" },
              ]}
              empty="No open deals."
            >
              {report.pipeline.stages.map((s) => (
                <RecordsTableRow key={s.stage}>
                  <RecordsTableCell><StatusBadge status={s.stage} /></RecordsTableCell>
                  <RecordsTableCell>{s.count}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(s.amount)}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(s.weighted)}</RecordsTableCell>
                </RecordsTableRow>
              ))}
            </RecordsTable>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Quotations by status</CardTitle></CardHeader>
          <CardContent>
            <RecordsTable
              columns={[
                { key: "status", label: "Status" },
                { key: "count", label: "Quotations" },
                { key: "amount", label: "Value" },
              ]}
              empty="No quotations in this period."
            >
              {quotations.length
                ? quotations.map(([status, q]) => (
                    <RecordsTableRow key={status}>
                      <RecordsTableCell><StatusBadge status={status} /></RecordsTableCell>
                      <RecordsTableCell>{q.count}</RecordsTableCell>
                      <RecordsTableCell>{formatMoney(q.amount)}</RecordsTableCell>
                    </RecordsTableRow>
                  ))
                : undefined}
            </RecordsTable>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
