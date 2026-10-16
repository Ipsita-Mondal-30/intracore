import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { listAttendance, listCorrections, localParts, orgTimezone } from "@/features/hr/attendance";
import { findMyEmployee } from "@/features/hr/employees";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { Pagination, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { dateInput, formatDate, formatDateTime, humanize } from "@/components/erp/format";
import { cn } from "@/lib/utils";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["PRESENT", "ABSENT", "HALF_DAY", "ON_LEAVE", "HOLIDAY", "WEEKLY_OFF"];

export default async function AttendancePage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["HR", "Attendance"]} title="Attendance" subtitle="Check-ins, daily records and corrections." />;
  const canSelf = can(ctx, "attendance.self");
  const canAll = can(ctx, "attendance.view") || can(ctx, "attendance.record") || can(ctx, "attendance.approve");
  if (!canSelf && !canAll) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view attendance.</p></div>;
  }

  const view = canAll && param(params, "view") === "all" ? "all" : "mine";
  const from = param(params, "from") ?? "";
  const to = param(params, "to") ?? "";
  const status = param(params, "status") ?? "";
  const [me, timeZone] = await Promise.all([findMyEmployee(ctx), orgTimezone(ctx.organizationId)]);
  const time = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone }).format(d) : "—");
  const today = dateInput(localParts(new Date(), timeZone).day);
  const [page, todayRow, pending, myCorrections, people] = await Promise.all([
    listAttendance(ctx, {
      mine: view === "mine" ? "true" : undefined,
      from: from || undefined,
      to: to || undefined,
      status: STATUSES.includes(status) ? status : undefined,
      page: param(params, "page"),
    }),
    me ? prisma.attendanceRecord.findFirst({ where: { employeeId: me.id }, orderBy: { date: "desc" } }) : null,
    can(ctx, "attendance.approve") ? listCorrections(ctx, { status: "PENDING", pageSize: 50 }) : null,
    canSelf || can(ctx, "attendance.record") ? listCorrections(ctx, { mine: "true", pageSize: 10 }) : null,
    can(ctx, "attendance.record")
      ? prisma.employee.findMany({ where: { AND: [companyScopeWhere(ctx), { status: { not: "EXITED" } }] }, select: { id: true, fullName: true, employeeNumber: true }, orderBy: { fullName: "asc" }, take: 1000 })
      : [],
  ]);
  const openToday = todayRow && dateInput(todayRow.date) === today ? todayRow : null;
  const tabHref = (v: string) => `/hr/attendance?view=${v}`;

  return (
    <div className="space-y-4">
      {header}

      <div className="grid gap-4 lg:grid-cols-2">
        {canSelf ? (
          <Card>
            <CardHeader><CardTitle>Today</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!me ? (
                <p className="text-muted">Your login is not linked to an employee record. Ask HR to link it.</p>
              ) : (
                <>
                  <p>
                    {openToday?.checkIn ? `Checked in ${time(openToday.checkIn)}` : "Not checked in yet"}
                    {openToday?.checkOut ? ` · checked out ${time(openToday.checkOut)}` : ""}
                    {openToday?.lateMinutes ? <span className="text-warning"> · {openToday.lateMinutes} min late</span> : null}
                  </p>
                  <div className="flex gap-2">
                    {!openToday?.checkIn ? <ActionButton path="/attendance/check-in" label="Check in" variant="default" /> : null}
                    {openToday?.checkIn && !openToday.checkOut ? <ActionButton path="/attendance/check-out" label="Check out" variant="default" /> : null}
                  </div>
                  <details className="rounded-xl border border-[var(--ic-border)] px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">Request a correction for a missed day</summary>
                    <ApiForm path="/attendance-corrections" submitLabel="Send for approval" successMessage="Correction requested" className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Date"><Input type="date" name="date" required max={today} /></Field>
                      <Field label="Status">
                        <Select name="proposed.status" defaultValue="PRESENT">
                          {STATUSES.slice(0, 3).map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                        </Select>
                      </Field>
                      <Field label="Check-in (local)"><Input type="time" name="proposed.checkIn" /></Field>
                      <Field label="Check-out (local)"><Input type="time" name="proposed.checkOut" /></Field>
                      <Field label="Reason" className="sm:col-span-2"><Input name="reason" required maxLength={1000} /></Field>
                    </ApiForm>
                  </details>
                </>
              )}
            </CardContent>
          </Card>
        ) : null}

        {people.length ? (
          <Card>
            <CardHeader><CardTitle>Record attendance</CardTitle></CardHeader>
            <CardContent>
              <ApiForm path="/attendance" submitLabel="Save record" successMessage="Attendance saved" className="grid gap-3 sm:grid-cols-3">
                <Field label="Date"><Input type="date" name="date" required defaultValue={today} /></Field>
                <Field label="Employee" className="sm:col-span-2">
                  <Select name="entries.0.employeeId" required>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.employeeNumber})</option>)}
                  </Select>
                </Field>
                <Field label="Status">
                  <Select name="entries.0.status" defaultValue="PRESENT">
                    {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                  </Select>
                </Field>
                <Field label="Check-in (local)"><Input type="time" name="entries.0.checkIn" /></Field>
                <Field label="Check-out (local)"><Input type="time" name="entries.0.checkOut" /></Field>
                <Field label="Notes" className="sm:col-span-3" hint="Overwrites an existing record for the day; the previous values stay in its history. Bulk entry: POST /api/v1/attendance with several entries.">
                  <Input name="entries.0.notes" maxLength={500} />
                </Field>
              </ApiForm>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {pending ? (
        <Card>
          <CardHeader><CardTitle>Corrections awaiting approval</CardTitle></CardHeader>
          <CardContent>
            {pending.items.length === 0 ? <p className="text-sm text-muted">Nothing to approve.</p> : null}
            <ul className="divide-y divide-[var(--ic-border)] text-sm">
              {pending.items.map((c) => {
                const own = c.requestedById === ctx.userId || c.attendance.employee.userId === ctx.userId;
                const p = c.proposed as Record<string, string | null>;
                return (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <Link href={`/hr/attendance/${c.attendance.id}`} className="font-medium text-primary hover:underline">
                        {c.attendance.employee.fullName} · {formatDate(c.attendance.date)}
                      </Link>
                      <p className="text-2xs text-subtle">
                        {Object.entries(p).map(([k, v]) => `${k}: ${k.startsWith("check") && v ? formatDateTime(v) : (v ?? "—")}`).join(" · ")} — “{c.reason}”
                      </p>
                    </div>
                    {own ? <span className="text-2xs text-subtle">Needs another approver</span> : (
                      <div className="flex gap-2">
                        <ActionButton path={`/attendance-corrections/${c.id}/approve`} label="Approve" variant="default" />
                        <ActionButton path={`/attendance-corrections/${c.id}/reject`} label="Reject" variant="ghost" prompt="Reason for rejecting" />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {myCorrections && myCorrections.items.length ? (
        <Card>
          <CardHeader><CardTitle>My correction requests</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {myCorrections.items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/hr/attendance/${c.attendance.id}`} className="text-primary hover:underline">{c.attendance.employee.fullName} · {formatDate(c.attendance.date)}</Link>
                  <StatusBadge status={c.status} />
                  {c.status === "PENDING" ? <ActionButton path={`/attendance-corrections/${c.id}/cancel`} label="Withdraw" variant="ghost" /> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            {canAll ? (
              <nav className="flex gap-4 border-b border-[var(--ic-border)] text-sm">
                {[["mine", "My attendance"], ["all", "Team & company"]].map(([v, label]) => (
                  <Link key={v} href={tabHref(v)} className={cn("-mb-px border-b-2 pb-2", view === v ? "border-primary font-medium text-foreground" : "border-transparent text-muted")}>{label}</Link>
                ))}
              </nav>
            ) : <span />}
            <form method="get" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="view" value={view} />
              <Input type="date" name="from" defaultValue={from} aria-label="From" className="max-w-[160px]" />
              <Input type="date" name="to" defaultValue={to} aria-label="To" className="max-w-[160px]" />
              <Select name="status" defaultValue={status} className="max-w-[160px]" aria-label="Status">
                <option value="">Status: all</option>
                {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </Select>
              <Button type="submit" size="sm" variant="secondary">Apply</Button>
            </form>
          </div>
          <RecordsTable
            columns={[
              { key: "date", label: "Date" },
              { key: "employee", label: "Employee" },
              { key: "in", label: "In" },
              { key: "out", label: "Out" },
              { key: "worked", label: "Worked" },
              { key: "late", label: "Late" },
              { key: "status", label: "Status" },
            ]}
            empty="No attendance records."
          >
            {page.items.length
              ? page.items.map((r) => (
                  <RecordsTableRow key={r.id}>
                    <RecordsTableCell>
                      <Link href={`/hr/attendance/${r.id}`} className="font-medium text-primary hover:underline">{formatDate(r.date)}</Link>
                      {r._count.corrections ? <span className="ml-2 text-2xs text-warning">correction pending</span> : null}
                    </RecordsTableCell>
                    <RecordsTableCell>{r.employee.fullName}</RecordsTableCell>
                    <RecordsTableCell>{time(r.checkIn)}</RecordsTableCell>
                    <RecordsTableCell>{time(r.checkOut)}</RecordsTableCell>
                    <RecordsTableCell>{r.workedMinutes != null ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : "—"}</RecordsTableCell>
                    <RecordsTableCell>{r.lateMinutes ? `${r.lateMinutes} min` : "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={{ ...params, view }} basePath="/hr/attendance" />
        </CardContent>
      </Card>
    </div>
  );
}
