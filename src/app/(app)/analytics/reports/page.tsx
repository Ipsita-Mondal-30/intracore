import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listSavedReports } from "@/features/reports/saved";
import { REPORT_ENTITIES } from "@/features/reports/catalog";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { formatDate } from "@/components/erp/format";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ReportsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listSavedReports(ctx, listParams(params));
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Analytics", "Reports"]}
        title="Report builder"
        subtitle="Build tabular reports from an approved catalog of fields. Saved reports run with each viewer's own access."
        actions={can(ctx, "report.build") ? <Link href="/analytics/reports/new" className="rounded-lg bg-primary px-3 py-2 text-sm text-white">New report</Link> : undefined}
      />
      <ListToolbar params={params} placeholder="Search reports…" />
      <Card>
        <CardContent className="pt-4">
          {page.items.length === 0 ? <p className="text-sm text-muted">No saved reports yet.</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr><th className="py-1">Name</th><th className="py-1">Data</th><th className="py-1">Shared</th><th className="py-1">Updated</th></tr>
              </thead>
              <tbody>
                {page.items.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--ic-border)]">
                    <td className="py-1.5"><Link className="text-primary" href={`/analytics/reports/${r.id}`}>{r.name}</Link>{r.createdById === ctx.userId ? null : <span className="ml-2 text-2xs text-subtle">shared with you</span>}</td>
                    <td className="py-1.5">{REPORT_ENTITIES[r.entity]?.label ?? r.entity}</td>
                    <td className="py-1.5">{r.isShared ? "Yes" : "No"}</td>
                    <td className="py-1.5">{formatDate(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Pagination page={page.page} pageSize={page.pageSize} total={page.total} params={params} basePath="/analytics/reports" />
    </div>
  );
}
