import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { findMyEmployee } from "@/features/hr/employees";
import { leaveCalendar, listLeaveBalances, listLeaveRequests, listLeaveTypes } from "@/features/hr/leave";
import { listDepartments } from "@/features/hr/org";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { Pagination, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { dateInput, formatDate, formatQty } from "@/components/erp/format";
import { cn } from "@/lib/utils";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];

export default async function LeavePage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["HR", "Leave"]} title="Leave" subtitle="Balances, requests, approvals and the team calendar." />;
  if (!can(ctx, "leave.view") && !can(ctx, "leave.apply") && !can(ctx, "leave.approve")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view leave.</p></div>;
  }

  const me = await findMyEmployee(ctx);
  const tabs: [string, string][] = [["mine", "My requests"], ["approve", "To approve"], ...(can(ctx, "leave.view") ? [["all", "All"] as [string, string]] : [])];
  const view = tabs.some(([v]) => v === param(params, "view")) ? param(params, "view")! : "mine";
  const status = param(params, "status") ?? "";
  const month = /^\d{4}-\d{2}$/.test(param(params, "month") ?? "") ? param(params, "month")! : dateInput(new Date()).slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const departmentId = param(params, "departmentId") ?? "";
  const canOnBehalf = can(ctx, "leave.approve");

  const [balances, types, page, calendar, departments, people] = await Promise.all([
    me ? listLeaveBalances(ctx, { employeeId: me.id }) : [],
    listLeaveTypes(ctx, me?.companyId ?? null),
    listLeaveRequests(ctx, {
      mine: view === "mine" ? "true" : undefined,
      toApprove: view === "approve" ? "true" : undefined,
      status: STATUSES.includes(status) ? status : undefined,
      page: param(params, "page"),
    }),
    leaveCalendar(ctx, {
      from: `${month}-01`,
      to: dateInput(new Date(Date.UTC(y, m, 0))),
      departmentId: departmentId || undefined,
      includePending: "true",
    }),
    listDepartments(ctx),
    canOnBehalf
      ? prisma.employee.findMany({ where: { AND: [companyScopeWhere(ctx), { status: { not: "EXITED" } }] }, select: { id: true, fullName: true, employeeNumber: true }, orderBy: { fullName: "asc" }, take: 1000 })
      : [],
  ]);
  const activeTypes = types.filter((t) => t.isActive);
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return dateInput(d).slice(0, 7);
  };

  return (
    <div className="space-y-4">
      {header}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>My balances ({new Date().getUTCFullYear()})</CardTitle></CardHeader>
          <CardContent>
            {!me ? <p className="text-sm text-muted">Your login is not linked to an employee record.</p> : null}
            {me && balances.length === 0 ? <p className="text-sm text-muted">No leave allocated yet.</p> : null}
            <ul className="space-y-1 text-sm">
              {balances.map((b) => (
                <li key={b.id} className="flex justify-between gap-2">
                  <span>{b.leaveType.name}</span>
                  <span className="text-muted">
                    <strong className="text-foreground">{formatQty(b.available)}</strong> left · {formatQty(b.used)} used{Number(b.pending) ? ` · ${formatQty(b.pending)} pending` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {(me && can(ctx, "leave.apply")) || canOnBehalf ? (
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Apply for leave</CardTitle></CardHeader>
            <CardContent>
              {activeTypes.length === 0 ? (
                <p className="text-sm text-muted">No leave types configured. HR can add them under HR settings.</p>
              ) : (
                <ApiForm path="/leave-requests" submitLabel="Submit request" successMessage="Leave requested" redirect="/hr/leave/:id" className="grid gap-3 sm:grid-cols-4">
                  {canOnBehalf ? (
                    <Field label="Employee">
                      <Select name="employeeId" defaultValue="">
                        {me ? <option value="">Myself</option> : null}
                        {people.filter((p) => p.id !== me?.id).map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.employeeNumber})</option>)}
                      </Select>
                    </Field>
                  ) : null}
                  <Field label="Leave type">
                    <Select name="leaveTypeId" required>
                      {activeTypes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isPaid ? "" : " (unpaid)"}</option>)}
                    </Select>
                  </Field>
                  <Field label="From"><Input type="date" name="startDate" required /></Field>
                  <Field label="To"><Input type="date" name="endDate" required /></Field>
                  <div className="flex flex-col justify-end gap-1 text-xs text-muted">
                    <label className="flex items-center gap-2"><input type="checkbox" name="halfDayStart" /> First day half</label>
                    <label className="flex items-center gap-2"><input type="checkbox" name="halfDayEnd" /> Last day half</label>
                  </div>
                  <Field label="Reason" className="sm:col-span-3"><Input name="reason" maxLength={1000} /></Field>
                </ApiForm>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardContent className="pt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <nav className="flex gap-4 border-b border-[var(--ic-border)] text-sm">
              {tabs.map(([v, label]) => (
                <Link key={v} href={`/hr/leave?view=${v}`} className={cn("-mb-px border-b-2 pb-2", view === v ? "border-primary font-medium text-foreground" : "border-transparent text-muted")}>{label}</Link>
              ))}
            </nav>
            <form method="get" className="flex items-center gap-2">
              <input type="hidden" name="view" value={view} />
              <Select name="status" defaultValue={status} className="max-w-[180px]" aria-label="Status">
                <option value="">Status: all</option>
                {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
              </Select>
              <Button type="submit" size="sm" variant="secondary">Apply</Button>
            </form>
          </div>
          <RecordsTable
            columns={[
              { key: "employee", label: "Employee" },
              { key: "type", label: "Type" },
              { key: "dates", label: "Dates" },
              { key: "days", label: "Days" },
              { key: "status", label: "Status" },
            ]}
            empty={view === "approve" ? "Nothing waiting for you." : "No leave requests."}
          >
            {page.items.length
              ? page.items.map((r) => (
                  <RecordsTableRow key={r.id}>
                    <RecordsTableCell>
                      <Link href={`/hr/leave/${r.id}`} className="font-medium text-primary hover:underline">{r.employee.fullName}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{r.leaveType.name}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(r.startDate)}{r.endDate > r.startDate ? ` – ${formatDate(r.endDate)}` : ""}</RecordsTableCell>
                    <RecordsTableCell>{formatQty(r.days)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={{ ...params, view }} basePath="/hr/leave" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Leave calendar</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <form method="get" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="view" value={view} />
            <Link href={`/hr/leave?view=${view}&month=${shift(-1)}${departmentId ? `&departmentId=${departmentId}` : ""}`} className="rounded-lg border border-[var(--ic-border)] px-3 py-1 text-xs">‹</Link>
            <Input type="month" name="month" defaultValue={month} className="max-w-[170px]" aria-label="Month" />
            <Link href={`/hr/leave?view=${view}&month=${shift(1)}${departmentId ? `&departmentId=${departmentId}` : ""}`} className="rounded-lg border border-[var(--ic-border)] px-3 py-1 text-xs">›</Link>
            <Select name="departmentId" defaultValue={departmentId} className="max-w-[200px]" aria-label="Department">
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
            <Button type="submit" size="sm" variant="secondary">Show</Button>
          </form>
          {calendar.leaves.length === 0 && calendar.holidays.length === 0 ? <p className="text-sm text-muted">No leave or holidays this month.</p> : null}
          <ul className="space-y-1 text-sm">
            {[
              ...calendar.holidays.map((h) => ({ key: h.id, start: h.date, end: h.date, label: <span className="font-medium">{h.name}</span>, tag: "Holiday" })),
              ...calendar.leaves.map((l) => ({
                key: l.id,
                start: l.startDate,
                end: l.endDate,
                label: <Link href={`/hr/leave/${l.id}`} className="text-primary hover:underline">{l.employee.fullName} · {l.leaveType.name}</Link>,
                tag: l.status === "PENDING" ? "Pending" : "",
              })),
            ]
              .sort((a, b) => a.start.getTime() - b.start.getTime())
              .map((row) => (
                <li key={row.key} className="flex flex-wrap items-baseline gap-2">
                  <span className="w-44 shrink-0 text-2xs text-subtle">{formatDate(row.start)}{row.end > row.start ? ` – ${formatDate(row.end)}` : ""}</span>
                  {row.label}
                  {row.tag ? <span className="text-2xs text-warning">{row.tag}</span> : null}
                </li>
              ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
