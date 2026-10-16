import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getAttendance, orgTimezone } from "@/features/hr/attendance";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatDateTime, humanize } from "@/components/erp/format";

const STATUSES = ["PRESENT", "ABSENT", "HALF_DAY", "ON_LEAVE", "HOLIDAY", "WEEKLY_OFF"];

export default async function AttendanceRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const [r, timeZone] = await Promise.all([
    getAttendance(ctx, id).catch((e) => {
      if (isAppError(e) && (e.status === 404 || e.status === 403)) notFound();
      throw e;
    }),
    orgTimezone(ctx.organizationId),
  ]);
  const time = (d: Date | string | null | undefined) => (d ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(d)) : "—");
  const isOwn = r.employee.userId === ctx.userId;
  const canRequest = (isOwn && can(ctx, "attendance.self")) || can(ctx, "attendance.record");
  const hasPending = r.corrections.some((c) => c.status === "PENDING");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["HR", "Attendance", formatDate(r.date)]}
        title={`${r.employee.fullName} · ${formatDate(r.date)}`}
        subtitle={`${r.employee.employeeNumber} · source ${humanize(r.source)}`}
        actions={<StatusBadge status={r.status} />}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Record</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-2 text-sm sm:grid-cols-3">
                <div><dt className="text-subtle">Check-in</dt><dd>{time(r.checkIn)}</dd></div>
                <div><dt className="text-subtle">Check-out</dt><dd>{time(r.checkOut)}</dd></div>
                <div><dt className="text-subtle">Worked</dt><dd>{r.workedMinutes != null ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : "—"}</dd></div>
                <div><dt className="text-subtle">Late</dt><dd>{r.lateMinutes ? `${r.lateMinutes} min` : "—"}</dd></div>
                <div className="sm:col-span-2"><dt className="text-subtle">Notes</dt><dd>{r.notes ?? "—"}</dd></div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Corrections</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {r.corrections.length === 0 ? <p className="text-sm text-muted">No corrections requested.</p> : null}
              <ul className="divide-y divide-[var(--ic-border)] text-sm">
                {r.corrections.map((c) => {
                  const p = c.proposed as Record<string, string | null>;
                  const mine = c.requestedById === ctx.userId;
                  const decide = c.status === "PENDING" && can(ctx, "attendance.approve") && !mine && !isOwn;
                  return (
                    <li key={c.id} className="space-y-1 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={c.status} />
                        <span className="text-2xs text-subtle">{formatDateTime(c.createdAt)}</span>
                        {decide ? (
                          <>
                            <ActionButton path={`/attendance-corrections/${c.id}/approve`} label="Approve" variant="default" confirm="Apply this correction to the record?" />
                            <ActionButton path={`/attendance-corrections/${c.id}/reject`} label="Reject" variant="ghost" prompt="Reason for rejecting" />
                          </>
                        ) : null}
                        {c.status === "PENDING" && mine ? <ActionButton path={`/attendance-corrections/${c.id}/cancel`} label="Withdraw" variant="ghost" /> : null}
                      </div>
                      <p>“{c.reason}”</p>
                      <p className="text-2xs text-subtle">
                        Proposed: {Object.entries(p).map(([k, v]) => `${humanize(k)} ${k.startsWith("check") ? time(v) : (v ?? "—")}`).join(" · ")}
                      </p>
                      {c.decisionNote ? <p className="text-2xs text-subtle">Decision: {c.decisionNote}</p> : null}
                    </li>
                  );
                })}
              </ul>
              {canRequest && !hasPending ? (
                <ApiForm path="/attendance-corrections" extra={{ attendanceId: id }} submitLabel="Request correction" successMessage="Correction requested" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Status">
                    <Select name="proposed.status" defaultValue="">
                      <option value="">Unchanged</option>
                      {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                    </Select>
                  </Field>
                  <Field label="Check-in (local)"><Input type="time" name="proposed.checkIn" /></Field>
                  <Field label="Check-out (local)"><Input type="time" name="proposed.checkOut" /></Field>
                  <Field label="Reason" className="sm:col-span-3"><Input name="reason" required maxLength={1000} /></Field>
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Employee</CardTitle></CardHeader>
            <CardContent className="text-sm">
              {can(ctx, "employee.view") || isOwn ? (
                <Link href={`/hr/employees/${r.employee.id}`} className="text-primary hover:underline">{r.employee.fullName}</Link>
              ) : r.employee.fullName}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="attendance" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
