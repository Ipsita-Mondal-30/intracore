import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getReviewCycle, listGoals, listPerformanceReviews } from "@/features/hr/performance";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate } from "@/components/erp/format";

export default async function ReviewCyclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "performance.view")) notFound();
  const cycle = await getReviewCycle(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const [reviews, goals] = await Promise.all([listPerformanceReviews(ctx, { cycleId: id, pageSize: 100 }), listGoals(ctx, { cycleId: id, pageSize: 100 })]);
  const manage = can(ctx, "performance.manage");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["HR", "Performance", cycle.name]}
        title={cycle.name}
        subtitle={`${formatDate(cycle.startDate)} – ${formatDate(cycle.endDate)}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={cycle.status} />
            {manage && cycle.status === "DRAFT" ? <ActionButton path={`/review-cycles/${id}/activate`} label="Activate" variant="default" confirm="Activate? A review is opened for every active employee." /> : null}
            {manage && cycle.status === "ACTIVE" ? <ActionButton path={`/review-cycles/${id}/close`} label="Close cycle" variant="ghost" confirm="Close the cycle? Reviews and goals become read-only." /> : null}
          </div>
        }
      />
      <Card>
        <CardHeader><CardTitle>Reviews</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable columns={[{ key: "e", label: "Employee" }, { key: "s", label: "Self" }, { key: "m", label: "Manager" }, { key: "st", label: "Status" }]} empty={cycle.status === "DRAFT" ? "Activate the cycle to open reviews." : "No reviews."}>
            {reviews.items.length ? reviews.items.map((r) => (
              <RecordsTableRow key={r.id}>
                <RecordsTableCell><Link href={`/hr/performance/employees/${r.employee.id}`} className="text-primary hover:underline">{r.employee.employeeNumber} {r.employee.fullName}</Link></RecordsTableCell>
                <RecordsTableCell>{r.selfRating ? `${r.selfRating}/5` : "—"}</RecordsTableCell>
                <RecordsTableCell>{r.managerRating ? `${r.managerRating}/5` : "—"}</RecordsTableCell>
                <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Goals</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable columns={[{ key: "e", label: "Employee" }, { key: "t", label: "Goal" }, { key: "p", label: "Progress / target" }, { key: "w", label: "Weight" }, { key: "s", label: "Status" }]} empty="No goals in this cycle.">
            {goals.items.length ? goals.items.map((g) => (
              <RecordsTableRow key={g.id}>
                <RecordsTableCell>{g.employee.fullName}</RecordsTableCell>
                <RecordsTableCell>{g.title}</RecordsTableCell>
                <RecordsTableCell>{g.currentValue?.toString() ?? "—"} / {g.targetValue?.toString() ?? "—"}</RecordsTableCell>
                <RecordsTableCell>{g.weight}</RecordsTableCell>
                <RecordsTableCell><StatusBadge status={g.status} /></RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
    </div>
  );
}
