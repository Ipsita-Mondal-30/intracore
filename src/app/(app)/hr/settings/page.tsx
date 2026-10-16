import { can, getAccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import { listDepartments, listDesignations, listHolidays, listShifts } from "@/features/hr/org";
import { listLeaveTypes } from "@/features/hr/leave";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { formatDate, formatQty } from "@/components/erp/format";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const days = (workDays: string) => workDays.split(",").map((d) => WEEKDAYS[Number(d) - 1]).join(", ");

export default async function HrSettingsPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["HR", "Settings"]} title="HR settings" subtitle="Departments, designations, shifts, holidays and leave types." />;
  if (!can(ctx, "hr.view") && !can(ctx, "hr.administer")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to manage HR settings.</p></div>;
  }
  const year = new Date().getUTCFullYear();
  const [companies, departments, designations, shifts, holidays, leaveTypes] = await Promise.all([
    can(ctx, "company.view") ? listCompanies(ctx) : [],
    listDepartments(ctx),
    listDesignations(ctx),
    listShifts(ctx),
    listHolidays(ctx, { year }),
    listLeaveTypes(ctx),
  ]);
  const admin = can(ctx, "hr.administer");
  const full = companies.filter((c) => ctx.companies.get(c.id) === "all");
  const manage = (companyId: string) => admin && ctx.companies.get(companyId) === "all";
  const companyName = new Map(companies.map((c) => [c.id, c.code]));
  const multi = companies.length > 1;
  const companySelect = (
    <Field label="Company">
      <Select name="companyId" required>
        {full.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
      </Select>
    </Field>
  );
  const tag = (companyId: string) => (multi ? <span className="text-2xs text-subtle">{companyName.get(companyId)} · </span> : null);
  const toggle = (path: string, active: boolean) => (
    <ActionButton path={path} method="PATCH" body={{ isActive: !active }} label={active ? "Deactivate" : "Activate"} variant="ghost" />
  );

  return (
    <div className="space-y-4">
      {header}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Departments</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1 text-sm">
              {departments.length === 0 ? <li className="text-muted">None yet.</li> : null}
              {departments.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {tag(d.companyId)}<strong>{d.code}</strong> · {d.name}
                    {d.parent ? <span className="text-2xs text-subtle"> under {d.parent.name}</span> : null}
                    <span className="text-2xs text-subtle"> · {d._count.employees} people</span>
                    {d.isActive ? null : <Badge tone="neutral" className="ml-2">Inactive</Badge>}
                  </span>
                  {manage(d.companyId) ? toggle(`/departments/${d.id}`, d.isActive) : null}
                </li>
              ))}
            </ul>
            {admin && full.length ? (
              <ApiForm path="/departments" submitLabel="Add department" successMessage="Department added" className="grid gap-3 sm:grid-cols-2">
                {companySelect}
                <Field label="Parent">
                  <Select name="parentId">
                    <option value="">None</option>
                    {departments.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </Select>
                </Field>
                <Field label="Code"><Input name="code" required maxLength={20} /></Field>
                <Field label="Name"><Input name="name" required maxLength={120} /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Designations</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1 text-sm">
              {designations.length === 0 ? <li className="text-muted">None yet.</li> : null}
              {designations.map((d) => (
                <li key={d.id}>
                  {d.name}
                  <span className="text-2xs text-subtle">{d.level != null ? ` · level ${d.level}` : ""} · {d._count.employees} people</span>
                </li>
              ))}
            </ul>
            {admin ? (
              <ApiForm path="/designations" submitLabel="Add designation" successMessage="Designation added" className="grid gap-3 sm:grid-cols-2">
                <Field label="Name"><Input name="name" required maxLength={120} /></Field>
                <Field label="Level" hint="Optional seniority, lower is junior"><Input type="number" name="level" min="0" max="100" /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Shifts</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1 text-sm">
              {shifts.length === 0 ? <li className="text-muted">None yet. Employees without a shift work Mon–Fri.</li> : null}
              {shifts.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {tag(s.companyId)}<strong>{s.name}</strong> {s.startTime}–{s.endTime}
                    <span className="text-2xs text-subtle"> · grace {s.graceMinutes} min · {days(s.workDays)} · {s._count.employees} people</span>
                    {s.isActive ? null : <Badge tone="neutral" className="ml-2">Inactive</Badge>}
                  </span>
                  {manage(s.companyId) ? toggle(`/shifts/${s.id}`, s.isActive) : null}
                </li>
              ))}
            </ul>
            {admin && full.length ? (
              <ApiForm path="/shifts" submitLabel="Add shift" successMessage="Shift added" className="grid gap-3 sm:grid-cols-3">
                {companySelect}
                <Field label="Name"><Input name="name" required maxLength={120} /></Field>
                <Field label="Grace (min)"><Input type="number" name="graceMinutes" min="0" max="240" defaultValue={10} /></Field>
                <Field label="Starts"><Input type="time" name="startTime" required defaultValue="09:00" /></Field>
                <Field label="Ends"><Input type="time" name="endTime" required defaultValue="18:00" /></Field>
                <Field label="Work days" hint="ISO weekdays, 1 = Mon … 7 = Sun"><Input name="workDays" defaultValue="1,2,3,4,5" pattern="[1-7](,[1-7])*" /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Holidays {year}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1 text-sm">
              {holidays.length === 0 ? <li className="text-muted">No holidays this year.</li> : null}
              {holidays.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{tag(h.companyId)}{formatDate(h.date)} · {h.name}</span>
                  {manage(h.companyId) ? <ActionButton path={`/holidays/${h.id}`} method="DELETE" label="Remove" variant="ghost" confirm="Remove this holiday? Leave already applied is not recalculated." /> : null}
                </li>
              ))}
            </ul>
            {admin && full.length ? (
              <ApiForm path="/holidays" submitLabel="Add holiday" successMessage="Holiday added" className="grid gap-3 sm:grid-cols-3">
                {companySelect}
                <Field label="Date"><Input type="date" name="date" required /></Field>
                <Field label="Name"><Input name="name" required maxLength={120} /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Leave types</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1 text-sm">
              {leaveTypes.length === 0 ? <li className="text-muted">None yet.</li> : null}
              {leaveTypes.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {tag(t.companyId)}<strong>{t.code}</strong> · {t.name}
                    <span className="text-2xs text-subtle">
                      {" "}· {formatQty(t.annualQuota)} days/yr · carry forward up to {formatQty(t.carryForwardMax)}
                      {t.isPaid ? "" : " · unpaid"}{t.allowNegative ? " · may go negative" : ""}
                    </span>
                    {t.isActive ? null : <Badge tone="neutral" className="ml-2">Inactive</Badge>}
                  </span>
                  {manage(t.companyId) ? toggle(`/leave-types/${t.id}`, t.isActive) : null}
                </li>
              ))}
            </ul>
            {admin && full.length ? (
              <>
                <ApiForm path="/leave-types" submitLabel="Add leave type" successMessage="Leave type added" className="grid gap-3 sm:grid-cols-4">
                  {companySelect}
                  <Field label="Code"><Input name="code" required maxLength={20} placeholder="CL" /></Field>
                  <Field label="Name"><Input name="name" required maxLength={80} placeholder="Casual leave" /></Field>
                  <Field label="Days per year"><Input name="annualQuota" type="number" min="0" max="366" step="0.5" required /></Field>
                  <Field label="Carry forward max"><Input name="carryForwardMax" type="number" min="0" max="366" step="0.5" defaultValue={0} /></Field>
                  <div className="flex flex-col justify-end gap-1 text-xs text-muted">
                    <label className="flex items-center gap-2"><input type="checkbox" name="isPaid" defaultChecked /> Paid</label>
                    <label className="flex items-center gap-2"><input type="checkbox" name="allowNegative" /> Allow negative balance (e.g. loss of pay)</label>
                  </div>
                </ApiForm>
                <ApiForm path="/leave-balances/allocate" submitLabel="Allocate yearly quota" successMessage="Leave allocated" confirm="Set every active employee's accrued leave to the yearly quota (carrying forward unused leave into new years)?" className="grid gap-3 border-t border-[var(--ic-border)] pt-4 sm:grid-cols-3">
                  {companySelect}
                  <Field label="Year"><Input type="number" name="year" min="2000" max="2100" defaultValue={year} required /></Field>
                </ApiForm>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
