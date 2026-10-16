import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listEmployees } from "@/features/hr/employees";
import { hrFormOptions } from "@/features/hr/org";
import { listCompanies } from "@/features/companies/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { dateInput, formatDate, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUSES = ["ONBOARDING", "ACTIVE", "ON_NOTICE", "EXITED"];
const TYPES = ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"];

export default async function EmployeesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["HR", "Employees"]} title="Employees" subtitle="Profiles, reporting lines and employment lifecycle." />;
  if (!can(ctx, "employee.view") && !can(ctx, "hr.view")) {
    return (
      <div className="space-y-4">
        {header}
        <p className="text-sm text-muted">
          You don&apos;t have permission to view employees. <Link href="/hr/leave" className="text-primary hover:underline">Go to my leave</Link>
        </p>
      </div>
    );
  }

  const canCreate = can(ctx, "employee.create");
  const [page, options, companies] = await Promise.all([
    listEmployees(ctx, listParams(params, ["status", "departmentId"])),
    hrFormOptions(ctx),
    canCreate && can(ctx, "company.view") ? listCompanies(ctx) : [],
  ]);

  return (
    <div className="space-y-4">
      {header}

      {canCreate && companies.length ? (
        <Card>
          <CardHeader><CardTitle>New employee</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/employees" submitLabel="Create employee" redirect="/hr/employees/:id" className="grid gap-3 sm:grid-cols-4">
              <Field label="Company / branch">
                <Select name="companyBranch" data-split="companyId,branchId" required>
                  {companies.flatMap((c) => [
                    ctx.companies.get(c.id) === "all" ? <option key={c.id} value={`${c.id}:`}>{c.code} · {c.name} (no branch)</option> : null,
                    ...c.branches.filter((b) => b.isActive).map((b) => <option key={b.id} value={`${c.id}:${b.id}`}>{c.code} · {b.name}</option>),
                  ])}
                </Select>
              </Field>
              <Field label="First name"><Input name="firstName" required maxLength={80} /></Field>
              <Field label="Last name"><Input name="lastName" maxLength={80} /></Field>
              <Field label="Joining date"><Input type="date" name="joiningDate" required defaultValue={dateInput(new Date())} /></Field>
              <Field label="Work email"><Input type="email" name="workEmail" /></Field>
              <Field label="Phone"><Input name="phone" maxLength={40} /></Field>
              <Field label="Employment type">
                <Select name="employmentType" defaultValue="FULL_TIME">
                  {TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                </Select>
              </Field>
              <Field label="Status">
                <Select name="status" defaultValue="ONBOARDING">
                  <option value="ONBOARDING">Onboarding</option>
                  <option value="ACTIVE">Active (already joined)</option>
                </Select>
              </Field>
              <Field label="Department">
                <Select name="departmentId">
                  <option value="">None</option>
                  {options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
              <Field label="Designation">
                <Select name="designationId">
                  <option value="">None</option>
                  {options.designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
              <Field label="Reporting manager">
                <Select name="managerId">
                  <option value="">None</option>
                  {options.people.map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.employeeNumber})</option>)}
                </Select>
              </Field>
              <Field label="Shift">
                <Select name="shiftId">
                  <option value="">None (Mon–Fri)</option>
                  {options.shifts.map((s) => <option key={s.id} value={s.id}>{s.name} {s.startTime}–{s.endTime}</option>)}
                </Select>
              </Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search name, number, email…"
            filters={[
              { name: "status", label: "Status", options: STATUSES.map((s) => ({ value: s, label: humanize(s) })) },
              { name: "departmentId", label: "Department", options: options.departments.map((d) => ({ value: d.id, label: d.name })) },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "No." },
              { key: "name", label: "Name" },
              { key: "dept", label: "Department" },
              { key: "designation", label: "Designation" },
              { key: "manager", label: "Manager" },
              { key: "joined", label: "Joined" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") || param(params, "status") ? "No employees match your filters." : "No employees yet."}
          >
            {page.items.length
              ? page.items.map((e) => (
                  <RecordsTableRow key={e.id}>
                    <RecordsTableCell>{e.employeeNumber}</RecordsTableCell>
                    <RecordsTableCell>
                      <Link href={`/hr/employees/${e.id}`} className="font-medium text-primary hover:underline">{e.fullName}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{e.department?.name ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{e.designation?.name ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{e.manager?.fullName ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(e.joiningDate)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={e.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/hr/employees" />
        </CardContent>
      </Card>
    </div>
  );
}
