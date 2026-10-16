import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getPayrollRun } from "@/features/hr/payroll";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatMoney } from "@/components/erp/format";
import { PayrollDisclaimer } from "../../disclaimer";

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "payroll.view")) notFound();
  const run = await getPayrollRun(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const open = run.status === "DRAFT" || run.status === "CALCULATED";

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["HR", "Payroll", run.period]}
        title={`Payroll ${run.period}`}
        subtitle={`${run.company.code} · ${run.company.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            {open && can(ctx, "payroll.run") ? (
              <>
                <ActionButton path={`/payroll-runs/${id}/calculate`} label={run.status === "DRAFT" ? "Calculate" : "Recalculate"} variant="default" />
                <ActionButton path={`/payroll-runs/${id}/cancel`} label="Cancel" variant="ghost" confirm="Cancel this payroll run? Its payslips are discarded." />
              </>
            ) : null}
            {run.status === "CALCULATED" && can(ctx, "payroll.approve") && run.createdById !== ctx.userId ? (
              <ActionButton path={`/payroll-runs/${id}/approve`} label="Approve" variant="default" confirm="Approve this payroll? Payslips become final." />
            ) : null}
          </div>
        }
      />
      <PayrollDisclaimer />
      <div className="grid gap-4 sm:grid-cols-4">
        {([["Gross earnings", run.totals.grossEarnings], ["Deductions", run.totals.totalDeductions], ["Net pay", run.totals.netPay], ["Employer contributions", run.totals.employerContributions]] as const).map(([label, value]) => (
          <Card key={label}><CardContent className="pt-5"><p className="text-2xs text-subtle">{label}</p><p className="text-lg font-semibold">{formatMoney(value)}</p></CardContent></Card>
        ))}
      </div>
      {run.journal ? <p className="text-sm">Journal: <Link href={`/finance/journals/${run.journal.id}`} className="text-primary hover:underline">{run.journal.number}</Link></p> : null}
      {run.skipped.length ? (
        <Card>
          <CardHeader><CardTitle>Not included</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {run.skipped.map((s) => <li key={s.employeeId}>{s.employeeNumber} {s.fullName} — <span className="text-muted">{s.reason}</span></li>)}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Payslips</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable
            columns={[{ key: "emp", label: "Employee" }, { key: "days", label: "Paid / calendar days" }, { key: "gross", label: "Gross" }, { key: "ded", label: "Deductions" }, { key: "net", label: "Net" }]}
            empty={run.status === "DRAFT" ? "Calculate the run to create payslips." : "No payslips."}
          >
            {run.payslips.length ? run.payslips.map((p) => (
              <RecordsTableRow key={p.id}>
                <RecordsTableCell><Link href={`/hr/payroll/payslips/${p.id}`} className="text-primary hover:underline">{p.employee.employeeNumber} {p.employee.fullName}</Link></RecordsTableCell>
                <RecordsTableCell>{p.paidDays.toString()} / {p.workingDays.toString()}</RecordsTableCell>
                <RecordsTableCell>{formatMoney(p.grossEarnings)}</RecordsTableCell>
                <RecordsTableCell>{formatMoney(p.totalDeductions)}</RecordsTableCell>
                <RecordsTableCell>{formatMoney(p.netPay)}</RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent><AuditTrail ctx={ctx} entity="payroll_run" entityId={id} /></CardContent>
      </Card>
    </div>
  );
}
