import Link from "next/link";
import { ZodError } from "zod";
import { can, getAccessContext } from "@/lib/access";
import { prisma } from "@/lib/db/prisma";
import { getDashboard } from "@/features/analytics/metrics";
import { MetricCard } from "@/features/analytics/metric-card";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { param } from "@/components/erp/list-controls";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AnalyticsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Analytics"]}
      title="Business overview"
      subtitle="Live figures from posted operational records. Hover ? on a card for its definition."
      actions={can(ctx, "finance.report") ? <Link href="/analytics/mis" className="text-sm text-primary">Management MIS →</Link> : undefined}
    />
  );
  if (!can(ctx, "dashboard.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view dashboards.</p></div>;
  }
  const query = { from: param(params, "from") || undefined, to: param(params, "to") || undefined, companyId: param(params, "companyId") || undefined };
  let data;
  try {
    data = await getDashboard(ctx, query);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    data = await getDashboard(ctx, { companyId: query.companyId });
  }
  const companies = await prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } });

  return (
    <div className="space-y-6">
      {header}
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label>From <Input type="date" name="from" defaultValue={data.period.from} /></label>
        <label>To <Input type="date" name="to" defaultValue={data.period.to} /></label>
        <label>
          Company
          <Select name="companyId" defaultValue={query.companyId ?? ""} className="min-w-[180px]">
            <option value="">All my companies</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </Select>
        </label>
        <Button type="submit" size="sm" variant="secondary">Apply</Button>
      </form>
      {data.currencies.length > 1 ? <p className="text-xs text-muted">Companies use different currencies; amounts are shown per currency and never added together.</p> : null}
      {data.sections.length === 0 ? <p className="text-sm text-muted">No sections are available for your role.</p> : null}
      {data.sections.map((section) => (
        <section key={section.key} className="space-y-2">
          <h2 className="text-sm font-semibold">{section.label}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {section.metrics.map((m) => <MetricCard key={m.key} metric={m} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
