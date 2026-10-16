import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getLeaveRequest } from "@/features/hr/leave";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatQty } from "@/components/erp/format";

export default async function LeaveRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const r = await getLeaveRequest(ctx, id).catch((e) => {
    if (isAppError(e) && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  });
  const isApplicant = r.employee.userId === ctx.userId;
  const isApprover = can(ctx, "leave.approve") || r.employee.manager?.userId === ctx.userId;
  const decider = r.approverId ? await prisma.user.findUnique({ where: { id: r.approverId }, select: { name: true, email: true } }) : null;
  const started = r.startDate <= new Date();
  const canCancel =
    r.status === "PENDING" ? isApplicant || can(ctx, "leave.approve") : r.status === "APPROVED" && (can(ctx, "leave.approve") || (isApplicant && !started));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["HR", "Leave", r.employee.fullName]}
        title={`${r.leaveType.name} · ${formatQty(r.days)} day(s)`}
        subtitle={`${r.employee.fullName} (${r.employee.employeeNumber}) · ${formatDate(r.startDate)}${r.endDate > r.startDate ? ` – ${formatDate(r.endDate)}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={r.status} />
            {r.status === "PENDING" && isApprover && !isApplicant ? (
              <>
                <ActionButton path={`/leave-requests/${id}/approve`} label="Approve" variant="default" confirm="Approve this leave? The days are deducted from the balance." />
                <ActionButton path={`/leave-requests/${id}/reject`} label="Reject" variant="ghost" prompt="Reason for rejecting" />
              </>
            ) : null}
            {canCancel ? (
              <ActionButton path={`/leave-requests/${id}/cancel`} label="Cancel leave" variant="ghost" confirm="Cancel this leave? Any deducted days are restored." />
            ) : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Request</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-subtle">From</dt><dd>{formatDate(r.startDate)}{r.halfDayStart ? " (half day)" : ""}</dd></div>
              <div><dt className="text-subtle">To</dt><dd>{formatDate(r.endDate)}{r.halfDayEnd ? " (half day)" : ""}</dd></div>
              <div><dt className="text-subtle">Working days charged</dt><dd>{formatQty(r.days)} <span className="text-2xs text-subtle">(weekly offs and holidays excluded)</span></dd></div>
              <div><dt className="text-subtle">Type</dt><dd>{r.leaveType.name}{r.leaveType.isPaid ? "" : " · unpaid"}</dd></div>
              <div className="sm:col-span-2"><dt className="text-subtle">Reason</dt><dd className="whitespace-pre-line">{r.reason ?? "—"}</dd></div>
              <div><dt className="text-subtle">Applied</dt><dd>{formatDateTime(r.createdAt)}</dd></div>
              <div><dt className="text-subtle">Reporting manager</dt><dd>{r.employee.manager?.fullName ?? "—"}</dd></div>
              {r.decidedAt ? (
                <div className="sm:col-span-2">
                  <dt className="text-subtle">Decision</dt>
                  <dd>{r.status.toLowerCase()} by {decider?.name ?? decider?.email ?? "—"} on {formatDateTime(r.decidedAt)}{r.decisionNote ? ` · “${r.decisionNote}”` : ""}</dd>
                </div>
              ) : null}
            </dl>
            {can(ctx, "employee.view") ? (
              <p className="mt-3 text-sm"><Link href={`/hr/employees/${r.employee.id}`} className="text-primary hover:underline">View employee</Link></p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>History</CardTitle></CardHeader>
          <CardContent><AuditTrail ctx={ctx} entity="leave_request" entityId={id} /></CardContent>
        </Card>
      </div>
    </div>
  );
}
