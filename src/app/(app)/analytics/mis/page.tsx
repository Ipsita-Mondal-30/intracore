import { ZodError } from "zod";
import { can, getAccessContext } from "@/lib/access";
import { prisma } from "@/lib/db/prisma";
import { getMis } from "@/features/analytics/mis";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { param } from "@/components/erp/list-controls";
import { formatMoney, formatQty } from "@/components/erp/format";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function MisPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Analytics", "MIS"]} title="Management MIS" subtitle="Revenue, margin, working capital and cash for one company. Each line names its source." />;
  if (!can(ctx, "finance.report")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You need the finance report permission to view the MIS.</p></div>;
  }
  const companies = await prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } });
  const query = { from: param(params, "from") || undefined, to: param(params, "to") || undefined, companyId: param(params, "companyId") || companies[0]?.id };
  let mis;
  try {
    mis = await getMis(ctx, query);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    mis = await getMis(ctx, { companyId: query.companyId });
  }
  const ccy = mis.company?.currency ?? "INR";
  const value = (v: string | number | null, key: string) =>
    v === null ? "—" : key === "gross_margin" ? `${v}%` : key === "revenue.invoices" ? String(v) : formatMoney(v, ccy);

  return (
    <div className="space-y-4">
      {header}
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label>
          Company
          <Select name="companyId" defaultValue={query.companyId ?? ""} className="min-w-[180px]">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </Select>
        </label>
        <label>From <Input type="date" name="from" defaultValue={mis.period.from} /></label>
        <label>To <Input type="date" name="to" defaultValue={mis.period.to} /></label>
        <Button type="submit" size="sm" variant="secondary">Apply</Button>
      </form>
      {!mis.company ? <p className="text-sm text-muted">No company in your scope.</p> : (
        <>
          <Card>
            <CardHeader><CardTitle>Summary ({ccy})</CardTitle></CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <tbody>
                  {mis.lines.map((l) => (
                    <tr key={l.key} className="border-t border-[var(--ic-border)] align-top">
                      <td className="py-1.5 pr-3">{l.label}<p className="text-2xs text-subtle">{l.source}</p></td>
                      <td className="py-1.5 text-right font-medium">{value(l.value, l.key)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {mis.omitted.length ? (
                <p className="mt-3 text-xs text-muted">Not shown: {mis.omitted.map((o) => o.key).join(", ")} — {mis.omitted[0].reason}.</p>
              ) : null}
            </CardContent>
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            {([
              ["Top customers", mis.topCustomers.source, mis.topCustomers.rows.map((r) => [r.name, formatMoney(r.amount, ccy)])],
              ["Top products", mis.topProducts.source, mis.topProducts.rows.map((r) => [`${r.sku} · ${r.name} (${formatQty(r.quantity)})`, formatMoney(r.amount, ccy)])],
              ["Purchase spend by vendor", mis.vendorSpend.source, mis.vendorSpend.rows.map((r) => [r.name, formatMoney(r.amount, ccy)])],
            ] as const).map(([title, source, rows]) => (
              <Card key={title}>
                <CardHeader><CardTitle>{title}</CardTitle><p className="text-2xs text-subtle">{source}</p></CardHeader>
                <CardContent>
                  {rows.length === 0 ? <p className="text-sm text-muted">Nothing in this period.</p> : (
                    <dl className="space-y-1 text-sm">
                      {rows.map(([k, v], i) => <div key={i} className="flex justify-between gap-2"><dt>{k}</dt><dd className="font-medium">{v}</dd></div>)}
                    </dl>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
