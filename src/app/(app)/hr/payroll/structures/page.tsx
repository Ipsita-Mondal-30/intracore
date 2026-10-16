import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listSalaryComponents, listSalaryStructures } from "@/features/hr/payroll";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { formatDate } from "@/components/erp/format";
import { StructureLines } from "./structure-lines";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SalaryStructuresPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["HR", "Payroll", "Structures"]} title="Salary structures" subtitle="Effective-dated pay per employee. The version in force at a month's end is used for that month." />;
  if (!can(ctx, "payroll.view")) return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view payroll.</p></div>;

  const fullCompanyIds = [...ctx.companies].filter(([, s]) => s === "all").map(([id]) => id);
  const [page, components, employees] = await Promise.all([
    listSalaryStructures(ctx, listParams(params, ["employeeId"])),
    listSalaryComponents(ctx, {}),
    can(ctx, "payroll.run")
      ? prisma.employee.findMany({ where: { organizationId: ctx.organizationId, companyId: { in: fullCompanyIds }, status: { not: "EXITED" } }, select: { id: true, employeeNumber: true, fullName: true }, orderBy: { employeeNumber: "asc" }, take: 500 })
      : [],
  ]);

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar params={params} placeholder="Search employee…" />
          <RecordsTable columns={[{ key: "emp", label: "Employee" }, { key: "from", label: "Effective from" }, { key: "lines", label: "Components" }]} empty="No salary structures yet.">
            {page.items.length ? page.items.map((s) => (
              <RecordsTableRow key={s.id}>
                <RecordsTableCell>{s.employee.employeeNumber} {s.employee.fullName}</RecordsTableCell>
                <RecordsTableCell>{formatDate(s.effectiveFrom)}</RecordsTableCell>
                <RecordsTableCell className="text-xs">
                  {s.lines.map((l) => `${l.component.code} ${l.component.calcType === "FIXED" ? l.value.toFixed(2) : `${l.value.toString()}%`}`).join(" · ")}
                </RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/hr/payroll/structures" />
        </CardContent>
      </Card>
      {employees.length && components.length ? (
        <Card>
          <CardHeader><CardTitle>New structure version</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/salary-structures" submitLabel="Save structure" successMessage="Structure saved" className="grid gap-3 sm:grid-cols-3">
              <Field label="Employee">
                <Select name="employeeId" required>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.fullName}</option>)}
                </Select>
              </Field>
              <Field label="Effective from"><Input type="date" name="effectiveFrom" required /></Field>
              <span />
              <StructureLines components={components.filter((c) => c.isActive).map((c) => ({ id: c.id, companyId: c.companyId, code: c.code, name: c.name, calcType: c.calcType }))} />
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
