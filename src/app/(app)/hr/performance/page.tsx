import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { listGoals, listPerformanceReviews, listReviewCycles } from "@/features/hr/performance";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate } from "@/components/erp/format";
import { GoalProgressForm, ReviewForm } from "./forms";

export default async function PerformancePage() {
  const ctx = await getAccessContext();
  const manage = can(ctx, "performance.manage");
  const [myGoals, myReviews, cycles, companies, employees] = await Promise.all([
    listGoals(ctx, { mine: "true", pageSize: 50 }),
    listPerformanceReviews(ctx, { pageSize: 50 }),
    can(ctx, "performance.view") ? listReviewCycles(ctx, { pageSize: 50 }) : null,
    manage ? prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }) : [],
    manage ? prisma.employee.findMany({ where: { ...companyScopeWhere(ctx), status: { in: ["ACTIVE", "ON_NOTICE"] } }, select: { id: true, employeeNumber: true, fullName: true }, orderBy: { employeeNumber: "asc" }, take: 500 }) : [],
  ]);
  const openCycles = cycles?.items.filter((c) => c.status !== "CLOSED") ?? [];
  const toWrite = myReviews.items.filter(
    (r) => r.cycle.status === "ACTIVE" && ((r.employee.userId === ctx.userId && r.status === "PENDING") || (r.reviewerId === ctx.userId && r.employee.userId !== ctx.userId && (r.status === "PENDING" || r.status === "SELF_SUBMITTED"))),
  );

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["HR", "Performance"]} title="Performance" subtitle="Review cycles, goals and reviews." />

      {toWrite.length ? (
        <Card>
          <CardHeader><CardTitle>Reviews to write</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {toWrite.map((r) => {
              const self = r.employee.userId === ctx.userId;
              return (
                <div key={r.id} className="space-y-2 border-b border-[var(--ic-border)] pb-3 last:border-0">
                  <p className="text-sm font-medium">{self ? "Self review" : `Manager review: ${r.employee.fullName}`} · {r.cycle.name}{!self && r.selfRating ? ` · self-rated ${r.selfRating}/5` : ""}</p>
                  <ReviewForm reviewId={r.id} action={self ? "self" : "manager"} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>My goals</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {myGoals.items.length === 0 ? <p className="text-sm text-muted">No goals assigned to you.</p> : myGoals.items.map((g) => (
            <div key={g.id} className="space-y-1 border-b border-[var(--ic-border)] pb-3 last:border-0">
              <p className="text-sm"><strong>{g.title}</strong> · target {g.targetValue?.toString() ?? "—"} · progress {g.currentValue?.toString() ?? "—"} · due {formatDate(g.dueDate)} <StatusBadge status={g.status} /></p>
              {g.cycle?.status !== "CLOSED" ? <GoalProgressForm goalId={g.id} current={g.currentValue?.toString() ?? ""} status={g.status} /> : null}
            </div>
          ))}
        </CardContent>
      </Card>

      {cycles ? (
        <Card>
          <CardHeader><CardTitle>Review cycles</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <RecordsTable columns={[{ key: "n", label: "Cycle" }, { key: "p", label: "Period" }, { key: "r", label: "Reviews" }, { key: "g", label: "Goals" }, { key: "s", label: "Status" }]} empty="No review cycles yet.">
              {cycles.items.length ? cycles.items.map((c) => (
                <RecordsTableRow key={c.id}>
                  <RecordsTableCell><Link href={`/hr/performance/cycles/${c.id}`} className="font-medium text-primary hover:underline">{c.name}</Link></RecordsTableCell>
                  <RecordsTableCell>{formatDate(c.startDate)} – {formatDate(c.endDate)}</RecordsTableCell>
                  <RecordsTableCell>{c._count.reviews}</RecordsTableCell>
                  <RecordsTableCell>{c._count.goals}</RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={c.status} /></RecordsTableCell>
                </RecordsTableRow>
              )) : undefined}
            </RecordsTable>
            {manage && companies.length ? (
              <ApiForm path="/review-cycles" submitLabel="Create cycle" redirect="/hr/performance/cycles/:id" className="grid gap-3 sm:grid-cols-4">
                <Field label="Company"><Select name="companyId" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select></Field>
                <Field label="Name"><Input name="name" required maxLength={120} placeholder="FY 2026-27 annual" /></Field>
                <Field label="Start"><Input type="date" name="startDate" required /></Field>
                <Field label="End"><Input type="date" name="endDate" required /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {manage && employees.length ? (
        <Card>
          <CardHeader><CardTitle>Assign a goal</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/goals" submitLabel="Add goal" successMessage="Goal added" className="grid gap-3 sm:grid-cols-3">
              <Field label="Employee"><Select name="employeeId" required>{employees.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.fullName}</option>)}</Select></Field>
              <Field label="Cycle"><Select name="cycleId"><option value="">No cycle</option>{openCycles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
              <Field label="Title"><Input name="title" required maxLength={200} /></Field>
              <Field label="Target value"><Input name="targetValue" inputMode="decimal" /></Field>
              <Field label="Weight"><Input type="number" name="weight" min={1} max={100} defaultValue={1} /></Field>
              <Field label="Due"><Input type="date" name="dueDate" /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
