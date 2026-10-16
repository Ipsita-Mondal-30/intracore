import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getEmployee } from "@/features/hr/employees";
import { hrFormOptions } from "@/features/hr/org";
import { listLeaveBalances } from "@/features/hr/leave";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { dateInput, formatDate, formatQty, humanize } from "@/components/erp/format";

const TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"];

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const e = await getEmployee(ctx, id).catch((err) => {
    if (isAppError(err) && err.status === 404) notFound();
    throw err;
  });
  const canEdit = can(ctx, "employee.update") && e.status !== "EXITED";
  const today = dateInput(new Date());
  const [options, members, branches, balances] = await Promise.all([
    canEdit ? hrFormOptions(ctx) : null,
    canEdit
      ? prisma.organizationMember.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { user: { select: { id: true, name: true, email: true } } } })
      : [],
    canEdit ? prisma.branch.findMany({ where: { companyId: e.companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
    can(ctx, "leave.view") || e.userId === ctx.userId ? listLeaveBalances(ctx, { employeeId: id }) : [],
  ]);
  const scope = ctx.companies.get(e.companyId);
  const branchOptions = branches.filter((b) => scope === "all" || scope?.has(b.id));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["HR", "Employees", e.employeeNumber]}
        title={e.fullName}
        subtitle={[e.employeeNumber, e.designation?.name, e.department?.name, e.company.name].filter(Boolean).join(" · ")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={e.status} />
            {canEdit && e.status === "ONBOARDING" ? (
              <ActionButton path={`/employees/${id}/activate`} label="Mark joined" variant="default" confirm="Mark this employee as joined (active)?" />
            ) : null}
            {canEdit && e.status === "ON_NOTICE" ? (
              <ActionButton path={`/employees/${id}/withdraw_notice`} label="Withdraw notice" confirm="Withdraw the notice and keep the employee active?" />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
            <CardContent>
              {canEdit && options ? (
                <ApiForm path={`/employees/${id}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="First name"><Input name="firstName" defaultValue={e.firstName} required maxLength={80} /></Field>
                  <Field label="Last name"><Input name="lastName" defaultValue={e.lastName ?? ""} data-nullable maxLength={80} /></Field>
                  <Field label="Date of birth"><Input type="date" name="dateOfBirth" defaultValue={dateInput(e.dateOfBirth)} data-nullable /></Field>
                  <Field label="Work email"><Input type="email" name="workEmail" defaultValue={e.workEmail ?? ""} data-nullable /></Field>
                  <Field label="Phone"><Input name="phone" defaultValue={e.phone ?? ""} data-nullable maxLength={40} /></Field>
                  <Field label="Employment type">
                    <Select name="employmentType" defaultValue={e.employmentType}>
                      {TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                    </Select>
                  </Field>
                  <Field label="Reporting manager">
                    <Select name="managerId" defaultValue={e.managerId ?? ""} data-nullable>
                      <option value="">None</option>
                      {options.people.filter((p) => p.id !== id).map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.employeeNumber})</option>)}
                    </Select>
                  </Field>
                  <Field label="Shift">
                    <Select name="shiftId" defaultValue={e.shiftId ?? ""} data-nullable>
                      <option value="">None (Mon–Fri)</option>
                      {options.shifts.filter((s) => s.companyId === e.companyId).map((s) => <option key={s.id} value={s.id}>{s.name} {s.startTime}–{s.endTime}</option>)}
                    </Select>
                  </Field>
                  <Field label="App login" hint="Links self-service leave and attendance">
                    <Select name="userId" defaultValue={e.userId ?? ""} data-nullable>
                      <option value="">Not linked</option>
                      {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name ?? m.user.email}</option>)}
                    </Select>
                  </Field>
                </ApiForm>
              ) : (
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-subtle">Work email</dt><dd>{e.workEmail ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Phone</dt><dd>{e.phone ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Employment type</dt><dd>{humanize(e.employmentType)}</dd></div>
                  <div><dt className="text-subtle">Reporting manager</dt><dd>{e.manager?.fullName ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Shift</dt><dd>{e.shift ? `${e.shift.name} ${e.shift.startTime}–${e.shift.endTime}` : "—"}</dd></div>
                  <div><dt className="text-subtle">Branch</dt><dd>{e.branch?.name ?? "—"}</dd></div>
                </dl>
              )}
            </CardContent>
          </Card>

          {canEdit && options ? (
            <Card>
              <CardHeader><CardTitle>Lifecycle</CardTitle></CardHeader>
              <CardContent className="space-y-5">
                {e.status === "ACTIVE" && !e.confirmationDate ? (
                  <ApiForm path={`/employees/${id}/confirm`} submitLabel="Confirm employment" successMessage="Confirmed" className="grid gap-3 sm:grid-cols-3">
                    <Field label="Confirmation date"><Input type="date" name="confirmationDate" required defaultValue={today} /></Field>
                  </ApiForm>
                ) : null}
                <ApiForm path={`/employees/${id}/transfer`} submitLabel="Transfer" successMessage="Transferred" className="grid gap-3 sm:grid-cols-4">
                  <Field label="Department">
                    <Select name="departmentId" defaultValue={e.departmentId ?? ""} data-nullable>
                      <option value="">None</option>
                      {options.departments.filter((d) => d.companyId === e.companyId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Branch">
                    <Select name="branchId" defaultValue={e.branchId ?? ""} data-nullable>
                      {scope === "all" ? <option value="">None</option> : null}
                      {branchOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Effective"><Input type="date" name="effectiveDate" required defaultValue={today} /></Field>
                  <Field label="Note"><Input name="note" maxLength={500} /></Field>
                </ApiForm>
                {e.status === "ACTIVE" ? (
                  <ApiForm path={`/employees/${id}/promote`} submitLabel="Promote / change designation" successMessage="Designation changed" className="grid gap-3 sm:grid-cols-3">
                    <Field label="New designation">
                      <Select name="designationId" required>
                        {options.designations.filter((d) => d.id !== e.designationId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="Effective"><Input type="date" name="effectiveDate" required defaultValue={today} /></Field>
                    <Field label="Note"><Input name="note" maxLength={500} /></Field>
                  </ApiForm>
                ) : null}
                {e.status === "ACTIVE" ? (
                  <ApiForm path={`/employees/${id}/notice`} submitLabel="Record resignation / notice" successMessage="Notice recorded" className="grid gap-3 sm:grid-cols-3">
                    <Field label="Last working day"><Input type="date" name="exitDate" required /></Field>
                    <Field label="Reason" className="sm:col-span-2"><Input name="reason" required maxLength={1000} /></Field>
                  </ApiForm>
                ) : null}
                <ApiForm path={`/employees/${id}/exit`} submitLabel="Exit employee" successMessage="Employee exited" confirm="Close this employee record? Pending leave requests will be cancelled." className="grid gap-3 sm:grid-cols-3">
                  <Field label="Exit date"><Input type="date" name="exitDate" defaultValue={dateInput(e.exitDate)} required /></Field>
                  <Field label="Reason" className="sm:col-span-2"><Input name="reason" defaultValue={e.exitReason ?? ""} maxLength={1000} /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Employment history</CardTitle></CardHeader>
            <CardContent>
              {e.events.length === 0 ? <p className="text-sm text-muted">No events.</p> : null}
              <ol className="space-y-2 text-sm">
                {e.events.map((ev) => {
                  const d = ev.details as { reason?: string; note?: string } | null;
                  return (
                    <li key={ev.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-2xs text-subtle">{formatDate(ev.effectiveDate)}</span>
                      <span className="font-medium">{humanize(ev.type)}</span>
                      {d?.reason || d?.note ? <span className="text-muted">“{d.reason ?? d.note}”</span> : null}
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Joined</dt><dd>{formatDate(e.joiningDate)}</dd></div>
                <div><dt className="text-subtle">Confirmed</dt><dd>{formatDate(e.confirmationDate)}</dd></div>
                {e.exitDate ? <div><dt className="text-subtle">Exit</dt><dd>{formatDate(e.exitDate)}{e.exitReason ? ` · ${e.exitReason}` : ""}</dd></div> : null}
                <div><dt className="text-subtle">Manager</dt><dd>{e.manager ? <Link href={`/hr/employees/${e.manager.id}`} className="text-primary hover:underline">{e.manager.fullName}</Link> : "—"}</dd></div>
                <div><dt className="text-subtle">Branch</dt><dd>{e.branch?.name ?? "—"}</dd></div>
              </dl>
            </CardContent>
          </Card>
          {e.reports.length ? (
            <Card>
              <CardHeader><CardTitle>Direct reports</CardTitle></CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {e.reports.map((r) => (
                    <li key={r.id}><Link href={`/hr/employees/${r.id}`} className="text-primary hover:underline">{r.fullName}</Link> <span className="text-2xs text-subtle">{r.employeeNumber}</span></li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>Leave balances ({new Date().getUTCFullYear()})</CardTitle></CardHeader>
            <CardContent>
              {balances.length === 0 ? <p className="text-sm text-muted">No balances allocated.</p> : null}
              <ul className="space-y-1 text-sm">
                {balances.map((b) => (
                  <li key={b.id} className="flex justify-between gap-2">
                    <span>{b.leaveType.name}</span>
                    <span className="text-muted">{formatQty(b.available)} available · {formatQty(b.used)} used</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="employee" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
