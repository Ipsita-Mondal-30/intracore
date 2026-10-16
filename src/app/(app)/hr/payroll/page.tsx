import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listPayrollRuns, listPayslips, listSalaryComponents } from "@/features/hr/payroll";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { Pagination, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatMoney, humanize } from "@/components/erp/format";
import { PayrollDisclaimer } from "./disclaimer";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function PayrollPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["HR", "Payroll"]} title="Payroll" subtitle="Monthly runs, payslips and the pay rules you define." />;

  if (!can(ctx, "payroll.view")) {
    const mine = await listPayslips(ctx, { pageSize: 24 });
    return (
      <div className="space-y-4">
        {header}
        <Card>
          <CardHeader><CardTitle>My payslips</CardTitle></CardHeader>
          <CardContent>
            {mine.items.length === 0 ? <p className="text-sm text-muted">No payslips yet.</p> : (
              <ul className="space-y-1 text-sm">
                {mine.items.map((p) => (
                  <li key={p.id}><Link href={`/hr/payroll/payslips/${p.id}`} className="text-primary hover:underline">{p.run.period}</Link> · net {formatMoney(p.netPay)}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const [runs, components, companies] = await Promise.all([
    listPayrollRuns(ctx, { page: param(params, "page") }),
    listSalaryComponents(ctx, {}),
    prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies].filter(([, s]) => s === "all").map(([id]) => id) } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
  ]);
  const canRun = can(ctx, "payroll.run");
  const companySelect = (
    <Field label="Company">
      <Select name="companyId" required>
        {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
      </Select>
    </Field>
  );

  return (
    <div className="space-y-4">
      {header}
      <PayrollDisclaimer />
      <Card>
        <CardHeader><CardTitle>Payroll runs</CardTitle></CardHeader>
        <CardContent>
          {canRun && companies.length ? (
            <ApiForm path="/payroll-runs" submitLabel="Create run" redirect="/hr/payroll/runs/:id" className="mb-4 grid gap-3 sm:grid-cols-3">
              {companySelect}
              <Field label="Month"><Input type="month" name="period" required /></Field>
            </ApiForm>
          ) : null}
          <RecordsTable columns={[{ key: "period", label: "Month" }, { key: "company", label: "Company" }, { key: "slips", label: "Payslips" }, { key: "status", label: "Status" }]} empty="No payroll runs yet.">
            {runs.items.length ? runs.items.map((r) => (
              <RecordsTableRow key={r.id}>
                <RecordsTableCell><Link href={`/hr/payroll/runs/${r.id}`} className="font-medium text-primary hover:underline">{r.period}</Link></RecordsTableCell>
                <RecordsTableCell>{r.company.code}</RecordsTableCell>
                <RecordsTableCell>{r._count.payslips}</RecordsTableCell>
                <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
          <Pagination {...runs} params={params} basePath="/hr/payroll" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Salary components</CardTitle>
          <Link href="/hr/payroll/structures" className="text-sm text-primary hover:underline">Salary structures →</Link>
        </CardHeader>
        <CardContent className="space-y-4">
          <RecordsTable columns={[{ key: "code", label: "Code" }, { key: "name", label: "Name" }, { key: "kind", label: "Kind" }, { key: "calc", label: "Rule" }, { key: "cap", label: "Cap" }, { key: "active", label: "Active" }]} empty="No components yet. Define every earning and deduction your payroll uses.">
            {components.length ? components.map((c) => (
              <RecordsTableRow key={c.id}>
                <RecordsTableCell className="font-mono">{c.code}</RecordsTableCell>
                <RecordsTableCell>{c.name}</RecordsTableCell>
                <RecordsTableCell>{humanize(c.kind)}</RecordsTableCell>
                <RecordsTableCell>
                  {c.calcType === "FIXED" ? `Fixed${c.prorate && c.kind === "EARNING" ? ", prorated" : ""}` : c.calcType === "PERCENT_OF_GROSS" ? "% of gross" : `% of ${c.baseComponentCode}`}
                </RecordsTableCell>
                <RecordsTableCell>{c.capAmount ? formatMoney(c.capAmount) : "—"}</RecordsTableCell>
                <RecordsTableCell>{c.isActive ? "Yes" : "No"}</RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
          {canRun && companies.length ? (
            <ApiForm path="/salary-components" submitLabel="Add component" successMessage="Component added" className="grid gap-3 sm:grid-cols-4">
              {companySelect}
              <Field label="Code"><Input name="code" required maxLength={30} placeholder="BASIC" /></Field>
              <Field label="Name"><Input name="name" required maxLength={100} /></Field>
              <Field label="Kind">
                <Select name="kind">{["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION"].map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select>
              </Field>
              <Field label="Calculation">
                <Select name="calcType">
                  <option value="FIXED">Fixed monthly amount</option>
                  <option value="PERCENT_OF_COMPONENT">% of another component</option>
                  <option value="PERCENT_OF_GROSS">% of gross earnings</option>
                </Select>
              </Field>
              <Field label="Base component code" hint="Only for % of another component"><Input name="baseComponentCode" maxLength={30} /></Field>
              <Field label="Monthly cap" hint="Optional upper limit you configure"><Input name="capAmount" inputMode="decimal" /></Field>
              <Field label="Order"><Input type="number" name="sortOrder" min={0} defaultValue={0} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="prorate" defaultChecked /> Prorate fixed earnings for unpaid days</label>
            </ApiForm>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
