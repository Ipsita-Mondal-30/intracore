import { notFound } from "next/navigation";
import { can, getAccessContext } from "@/lib/access";
import { isAppError } from "@/lib/errors";
import { reportCatalog } from "@/features/reports/catalog";
import { getSavedReport } from "@/features/reports/saved";
import { ReportBuilder, type Definition } from "@/features/reports/report-builder";
import { PageHeader } from "@/components/layout/page-header";

export const dynamic = "force-dynamic";

export default async function SavedReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const report = await getSavedReport(ctx, id).catch((error) => {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  });
  // The saved report is only visible when the caller can read its entity, so it is in the catalog.
  const catalog = reportCatalog(ctx).filter((e) => can(ctx, "report.build") || e.key === report.entity);
  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Analytics", "Reports"]} title={report.name} subtitle={report.isShared ? "Shared report" : "Private report"} />
      <ReportBuilder
        catalog={catalog}
        initial={report.definition as Definition}
        saved={{ id: report.id, name: report.name, isShared: report.isShared, mine: report.createdById === ctx.userId }}
        canSave={can(ctx, "report.build")}
        canExport={can(ctx, "data.export")}
      />
    </div>
  );
}
