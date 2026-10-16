import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { getAccessContext } from "@/lib/access";
import { listGoals, listPerformanceReviews } from "@/features/hr/performance";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate } from "@/components/erp/format";

/** Review and goal history for one employee across cycles (visibility rules from the services). */
export default async function EmployeePerformancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const [employee, reviews, goals] = await Promise.all([
    prisma.employee.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { fullName: true, employeeNumber: true } }),
    listPerformanceReviews(ctx, { employeeId: id, pageSize: 100 }),
    listGoals(ctx, { employeeId: id, pageSize: 100 }),
  ]);
  // Only shown when the viewer can see some of this history, so ids are not confirmed otherwise.
  if (!employee || reviews.total + goals.total === 0) notFound();

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["HR", "Performance", employee.fullName]} title={employee.fullName} subtitle={`${employee.employeeNumber} · performance history`} />
      <Card>
        <CardHeader><CardTitle>Reviews</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable columns={[{ key: "c", label: "Cycle" }, { key: "s", label: "Self" }, { key: "m", label: "Manager" }, { key: "st", label: "Status" }]} empty="No reviews you can see.">
            {reviews.items.length ? reviews.items.map((r) => (
              <RecordsTableRow key={r.id}>
                <RecordsTableCell>{r.cycle.name} <span className="text-2xs text-subtle">{formatDate(r.cycle.startDate)} – {formatDate(r.cycle.endDate)}</span></RecordsTableCell>
                <RecordsTableCell>{r.selfRating ? `${r.selfRating}/5` : "—"}{r.selfComments ? <span className="block text-2xs text-muted">{r.selfComments}</span> : null}</RecordsTableCell>
                <RecordsTableCell>{r.managerRating ? `${r.managerRating}/5` : "—"}{r.managerComments ? <span className="block text-2xs text-muted">{r.managerComments}</span> : null}</RecordsTableCell>
                <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Goals</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable columns={[{ key: "t", label: "Goal" }, { key: "c", label: "Cycle" }, { key: "p", label: "Progress / target" }, { key: "d", label: "Due" }, { key: "s", label: "Status" }]} empty="No goals you can see.">
            {goals.items.length ? goals.items.map((g) => (
              <RecordsTableRow key={g.id}>
                <RecordsTableCell>{g.title}</RecordsTableCell>
                <RecordsTableCell>{g.cycle?.name ?? "—"}</RecordsTableCell>
                <RecordsTableCell>{g.currentValue?.toString() ?? "—"} / {g.targetValue?.toString() ?? "—"}</RecordsTableCell>
                <RecordsTableCell>{formatDate(g.dueDate)}</RecordsTableCell>
                <RecordsTableCell><StatusBadge status={g.status} /></RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
    </div>
  );
}
