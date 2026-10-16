import Link from "next/link";
import { getProfile, listAttendance, listLeaveBalances, listLeaveRequests, listLeaveTypes, listMyTasks, listPayslips } from "@/features/portal/employee";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatDateTime, formatMoney, formatQty, humanize } from "@/components/erp/format";
import { pagePortal, PortalHeader, Section } from "@/app/portal/_components/portal-page";
import { PortalAction, PortalForm } from "@/app/portal/_components/portal-client";
import { employeeLinks } from "./nav";

export default async function EmployeePortal() {
  const p = await pagePortal("EMPLOYEE");
  const [me, attendance, balances, types, requests, payslips, tasks] = await Promise.all([
    getProfile(p), listAttendance(p, { pageSize: 31 }), listLeaveBalances(p), listLeaveTypes(p), listLeaveRequests(p, { pageSize: 50 }), listPayslips(p), listMyTasks(p),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <PortalHeader title={`Hello, ${me.fullName}`} organization={p.organizationName} links={employeeLinks} />
      <Section title="Profile">
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          {[
            ["Employee no.", me.employeeNumber], ["Designation", me.designation?.name], ["Department", me.department?.name],
            ["Manager", me.manager?.fullName], ["Company", me.company.name], ["Branch", me.branch?.name],
            ["Joined", formatDate(me.joiningDate)], ["Type", humanize(me.employmentType)], ["Shift", me.shift ? `${me.shift.name} (${me.shift.startTime}–${me.shift.endTime})` : null],
          ].map(([k, v]) => (
            <div key={k as string}><dt className="text-2xs uppercase text-subtle">{k}</dt><dd>{v ?? "—"}</dd></div>
          ))}
        </dl>
      </Section>
      <Section title="Attendance">
        <div className="mb-3 flex gap-2">
          <PortalAction path="/employee/attendance/check-in" label="Check in" variant="default" />
          <PortalAction path="/employee/attendance/check-out" label="Check out" />
        </div>
        <RecordsTable columns={[{ key: "d", label: "Date" }, { key: "s", label: "Status" }, { key: "i", label: "In" }, { key: "o", label: "Out" }, { key: "w", label: "Worked" }]} empty="No attendance yet.">
          {attendance.items.length
            ? attendance.items.map((r) => (
                <RecordsTableRow key={r.id}>
                  <RecordsTableCell>{formatDate(r.date)}</RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
                  <RecordsTableCell>{formatDateTime(r.checkIn)}</RecordsTableCell>
                  <RecordsTableCell>{formatDateTime(r.checkOut)}</RecordsTableCell>
                  <RecordsTableCell>{r.workedMinutes !== null ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : "—"}{r.lateMinutes ? ` · late ${r.lateMinutes}m` : ""}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Leave">
        <div className="mb-4 flex flex-wrap gap-3 text-sm">
          {balances.length ? balances.map((b) => <span key={b.leaveType.id} className="rounded-full border border-[var(--ic-border)] px-3 py-1">{b.leaveType.name}: {formatQty(b.available)} available</span>) : <span className="text-muted">No leave balances for this year.</span>}
        </div>
        {types.length ? (
          <PortalForm path="/employee/leave/requests" submitLabel="Apply" successMessage="Leave requested">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Type"><Select name="leaveTypeId">{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
              <Field label="From"><Input name="startDate" type="date" required min={today} /></Field>
              <Field label="To"><Input name="endDate" type="date" required min={today} /></Field>
              <Field label="Reason"><Input name="reason" maxLength={1000} /></Field>
            </div>
            <label className="mr-4 text-sm"><input type="checkbox" name="halfDayStart" className="mr-1" />Half day at start</label>
            <label className="text-sm"><input type="checkbox" name="halfDayEnd" className="mr-1" />Half day at end</label>
          </PortalForm>
        ) : null}
        <RecordsTable className="mt-4" columns={[{ key: "t", label: "Type" }, { key: "p", label: "Dates" }, { key: "d", label: "Days" }, { key: "s", label: "Status" }, { key: "a", label: "" }]} empty="No leave requests.">
          {requests.items.length
            ? requests.items.map((r) => (
                <RecordsTableRow key={r.id}>
                  <RecordsTableCell>{r.leaveType.name}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(r.startDate)} – {formatDate(r.endDate)}</RecordsTableCell>
                  <RecordsTableCell>{formatQty(r.days)}</RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={r.status} />{r.decisionNote ? <span className="ml-2 text-xs text-muted">{r.decisionNote}</span> : null}</RecordsTableCell>
                  <RecordsTableCell>
                    {r.status === "PENDING" || (r.status === "APPROVED" && r.startDate.toISOString().slice(0, 10) > today) ? (
                      <PortalAction path={`/employee/leave/requests/${r.id}/cancel`} label="Cancel" confirm="Cancel this leave request?" />
                    ) : null}
                  </RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Payslips">
        <RecordsTable columns={[{ key: "p", label: "Period" }, { key: "g", label: "Gross" }, { key: "d", label: "Deductions" }, { key: "n", label: "Net pay" }]} empty="No payslips yet.">
          {payslips.length
            ? payslips.map((s) => (
                <RecordsTableRow key={s.id}>
                  <RecordsTableCell><Link className="font-medium text-primary hover:underline" href={`/portal/employee/payslips/${s.id}`}>{s.run.period}</Link></RecordsTableCell>
                  <RecordsTableCell>{formatMoney(s.grossEarnings)}</RecordsTableCell>
                  <RecordsTableCell>{formatMoney(s.totalDeductions)}</RecordsTableCell>
                  <RecordsTableCell className="font-medium">{formatMoney(s.netPay)}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
      <Section title="Assigned tasks">
        <ul className="space-y-2 text-sm">
          {[...tasks.tasks.map((t) => ({ id: t.id, title: t.title, due: t.dueAt, status: t.status, where: null as string | null })),
            ...tasks.projectTasks.map((t) => ({ id: t.id, title: t.title, due: t.dueDate, status: t.status, where: `${t.project.code} · ${t.project.name}` }))].map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3">
              <StatusBadge status={t.status} />
              <span className="font-medium">{t.title}</span>
              {t.where ? <span className="text-xs text-muted">{t.where}</span> : null}
              <span className="text-xs text-subtle">due {formatDate(t.due)}</span>
            </li>
          ))}
          {tasks.tasks.length + tasks.projectTasks.length === 0 ? <li className="text-muted">Nothing assigned.</li> : null}
        </ul>
      </Section>
    </div>
  );
}
