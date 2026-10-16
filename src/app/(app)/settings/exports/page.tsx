import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listMyExports } from "@/features/reports/exports";
import { REPORT_ENTITIES } from "@/features/reports/catalog";
import { ExportDownloadButton } from "@/features/reports/export-download-button";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/erp/status-badge";
import { Pagination, listParams } from "@/components/erp/list-controls";
import { formatDateTime } from "@/components/erp/format";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ExportsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Settings", "Exports"]} title="My exports" subtitle="CSV exports you requested. Files are kept for 7 days; download links are valid for one minute." />;
  if (!can(ctx, "data.export")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to export data.</p></div>;
  }
  const page = await listMyExports(ctx, listParams(params));
  const now = new Date();
  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-4">
          {page.items.length === 0 ? (
            <p className="text-sm text-muted">No exports yet. Start one from the <Link className="text-primary" href="/analytics/reports">report builder</Link>.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr><th className="py-1">Requested</th><th className="py-1">Data</th><th className="py-1">Status</th><th className="py-1 text-right">Rows</th><th className="py-1">Expires</th><th /></tr>
              </thead>
              <tbody>
                {page.items.map((e) => {
                  const expired = e.status === "EXPIRED" || (e.expiresAt !== null && e.expiresAt < now);
                  return (
                    <tr key={e.id} className="border-t border-[var(--ic-border)]">
                      <td className="py-1.5">{formatDateTime(e.createdAt)}</td>
                      <td className="py-1.5">{(e.params as { name?: string } | null)?.name ?? REPORT_ENTITIES[e.entity]?.label ?? e.entity}</td>
                      <td className="py-1.5"><StatusBadge status={expired ? "EXPIRED" : e.status} />{e.error ? <p className="text-2xs text-subtle">{e.error}</p> : null}</td>
                      <td className="py-1.5 text-right">{e.rowCount ?? "—"}</td>
                      <td className="py-1.5">{formatDateTime(e.expiresAt)}</td>
                      <td className="py-1.5 text-right">{e.status === "COMPLETED" && !expired ? <ExportDownloadButton id={e.id} /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Pagination page={page.page} pageSize={page.pageSize} total={page.total} params={params} basePath="/settings/exports" />
    </div>
  );
}
