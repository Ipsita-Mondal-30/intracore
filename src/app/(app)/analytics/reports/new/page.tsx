import { can, getAccessContext } from "@/lib/access";
import { reportCatalog } from "@/features/reports/catalog";
import { ReportBuilder } from "@/features/reports/report-builder";
import { PageHeader } from "@/components/layout/page-header";

export const dynamic = "force-dynamic";

export default async function NewReportPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Analytics", "Reports", "New"]} title="New report" />;
  const catalog = can(ctx, "report.build") ? reportCatalog(ctx) : [];
  if (!catalog.length) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You need the report builder permission and access to at least one kind of data.</p></div>;
  }
  return (
    <div className="space-y-4">
      {header}
      <ReportBuilder catalog={catalog} canSave canExport={can(ctx, "data.export")} />
    </div>
  );
}
