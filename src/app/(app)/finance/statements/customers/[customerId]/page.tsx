import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { customerStatement } from "@/features/finance/reports";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { param } from "@/components/erp/list-controls";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DOC_PATH: Record<string, string> = { INVOICE: "invoices", CREDIT_NOTE: "credit-notes", RECEIPT: "receipts" };

export default async function CustomerStatementPage({ params, searchParams }: Props) {
  const { customerId } = await params;
  const sp = await searchParams;
  const ctx = await getAccessContext();

  if (!can(ctx, "finance.report")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Statements", "Customer"]} title="Customer statement" />
        <Card>
          <CardContent className="pt-5 text-sm text-muted">
            Statements need the finance report permission. Ask an administrator if you need access.
          </CardContent>
        </Card>
      </div>
    );
  }

  const companies = await prisma.company.findMany({
    where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } },
    select: { id: true, code: true, name: true, baseCurrency: true },
    orderBy: [{ isDefault: "desc" }, { code: "asc" }],
  });
  if (companies.length === 0) notFound();
  const company = companies.find((c) => c.id === param(sp, "companyId")) ?? companies[0];
  const from = param(sp, "from") ?? "";
  const to = param(sp, "to") ?? "";

  const st = await customerStatement(ctx, company.id, customerId, { ...(from ? { from } : {}), ...(to ? { to } : {}) }).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const cur = company.baseCurrency;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Statements", st.party.name]}
        title={`Statement · ${st.party.name}`}
        subtitle={`${company.code} · ${st.party.gstin ?? "Unregistered"} · posted invoices, credit notes and receipts`}
        actions={<Link href={`/crm/customers/${customerId}`} className="text-sm text-primary hover:underline">Customer</Link>}
      />

      <Card>
        <CardContent className="space-y-4 pt-5">
          <form method="get" className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-2xs text-subtle">Company</span>
              <Select name="companyId" defaultValue={company.id} className="min-w-[180px]">
                {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </Select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-2xs text-subtle">From</span>
              <Input type="date" name="from" defaultValue={from} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-2xs text-subtle">To</span>
              <Input type="date" name="to" defaultValue={to} />
            </label>
            <Button type="submit" size="sm" variant="secondary">Apply</Button>
          </form>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr className="border-b border-[var(--ic-border)]">
                  <th className="py-2 pr-2">Date</th>
                  <th className="py-2 pr-2">Document</th>
                  <th className="py-2 pr-2 text-right">Debit</th>
                  <th className="py-2 pr-2 text-right">Credit</th>
                  <th className="py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[var(--ic-border)] text-muted">
                  <td className="py-2 pr-2">{from ? formatDate(from) : "—"}</td>
                  <td className="py-2 pr-2" colSpan={3}>Opening balance</td>
                  <td className="py-2 text-right">{formatMoney(st.openingBalance, cur)}</td>
                </tr>
                {st.rows.length === 0 ? (
                  <tr><td colSpan={5} className="py-8 text-center text-muted">No posted documents in this period.</td></tr>
                ) : (
                  st.rows.map((row) => (
                    <tr key={`${row.type}-${row.documentId}`} className="border-b border-[var(--ic-border)]">
                      <td className="py-2 pr-2">{formatDate(row.date)}</td>
                      <td className="py-2 pr-2">
                        {humanize(row.type)}{" "}
                        <Link href={`/finance/${DOC_PATH[row.type] ?? "invoices"}/${row.documentId}`} className="text-primary hover:underline">{row.number ?? "—"}</Link>
                      </td>
                      <td className="py-2 pr-2 text-right">{Number(row.debit) ? formatMoney(row.debit, cur) : ""}</td>
                      <td className="py-2 pr-2 text-right">{Number(row.credit) ? formatMoney(row.credit, cur) : ""}</td>
                      <td className="py-2 text-right">{formatMoney(row.balance, cur)}</td>
                    </tr>
                  ))
                )}
                <tr className="font-semibold">
                  <td className="py-2 pr-2">{to ? formatDate(to) : ""}</td>
                  <td className="py-2 pr-2" colSpan={3}>Closing balance {Number(st.closingBalance) < 0 ? "(customer in credit)" : ""}</td>
                  <td className="py-2 text-right">{formatMoney(st.closingBalance, cur)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
