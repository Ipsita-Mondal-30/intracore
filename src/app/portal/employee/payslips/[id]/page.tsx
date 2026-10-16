import { getPayslip } from "@/features/portal/employee";
import { formatMoney, formatQty, humanize } from "@/components/erp/format";
import { orNotFound, pagePortal, PortalHeader, Section } from "@/app/portal/_components/portal-page";
import { employeeLinks } from "../../nav";

type Line = { code: string; name: string; kind: string; amount: string };

export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await pagePortal("EMPLOYEE");
  const s = await orNotFound(getPayslip(p, id));
  const lines = (Array.isArray(s.lines) ? s.lines : []) as Line[];
  return (
    <div>
      <PortalHeader title="Payslip" organization={p.organizationName} links={employeeLinks} />
      <Section title={`${s.run.company.name} · ${s.run.period}`}>
        <p className="mb-3 text-sm text-muted">Working days {formatQty(s.workingDays)} · paid {formatQty(s.paidDays)} · unpaid {formatQty(s.unpaidDays)}</p>
        <table className="w-full text-sm">
          <tbody>
            {lines.map((l) => (
              <tr key={l.code} className="border-b border-[var(--ic-border)]">
                <td className="py-1.5">{l.name}</td>
                <td className="py-1.5 text-xs text-subtle">{humanize(l.kind)}</td>
                <td className="py-1.5 text-right">{formatMoney(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="ml-auto mt-4 max-w-xs space-y-1 text-sm">
          <div className="flex justify-between"><dt>Gross earnings</dt><dd>{formatMoney(s.grossEarnings)}</dd></div>
          <div className="flex justify-between"><dt>Deductions</dt><dd>{formatMoney(s.totalDeductions)}</dd></div>
          <div className="flex justify-between border-t border-[var(--ic-border)] pt-2 font-semibold"><dt>Net pay</dt><dd>{formatMoney(s.netPay)}</dd></div>
        </dl>
      </Section>
    </div>
  );
}
