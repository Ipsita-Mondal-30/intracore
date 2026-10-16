import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { getAccessContext } from "@/lib/access";
import { getPayslip, type PayslipLine } from "@/features/hr/payroll";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatMoney, humanize } from "@/components/erp/format";

export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const slip = await getPayslip(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const lines = slip.lines as PayslipLine[];
  const section = (kind: string) => lines.filter((l) => l.kind === kind);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["HR", "Payroll", "Payslip"]}
        title={`${slip.employee.fullName} · ${slip.run.period}`}
        subtitle={`${slip.employee.employeeNumber} · ${slip.run.company.name}`}
        actions={<StatusBadge status={slip.run.status} />}
      />
      <Card>
        <CardContent className="space-y-4 pt-5 text-sm">
          <p>Calendar days {slip.workingDays.toString()} · paid {slip.paidDays.toString()} · unpaid {slip.unpaidDays.toString()}</p>
          {["EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION"].map((kind) =>
            section(kind).length ? (
              <div key={kind}>
                <p className="mb-1 font-medium">{humanize(kind)}s</p>
                <table className="w-full max-w-xl">
                  <tbody>
                    {section(kind).map((l) => (
                      <tr key={l.code} className="border-b border-[var(--ic-border)] last:border-0">
                        <td className="py-1">{l.name} <span className="text-2xs text-subtle">{l.code}</span>{l.note ? <span className="block text-2xs text-warning">{l.note} (computed {formatMoney(l.computed)})</span> : null}</td>
                        <td className="py-1 text-right">{formatMoney(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null,
          )}
          <dl className="grid max-w-xl grid-cols-2 gap-1">
            <dt>Gross earnings</dt><dd className="text-right">{formatMoney(slip.grossEarnings)}</dd>
            <dt>Deductions</dt><dd className="text-right">{formatMoney(slip.totalDeductions)}</dd>
            <dt className="font-semibold">Net pay</dt><dd className="text-right font-semibold">{formatMoney(slip.netPay)}</dd>
          </dl>
          <p className="text-2xs text-subtle">Computed from pay rules configured by your organization; not a statutory-compliant payslip.</p>
        </CardContent>
      </Card>
    </div>
  );
}
