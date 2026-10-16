import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { vendorStatement } from "@/features/finance/reports";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/erp/api-form";
import { param } from "@/components/erp/list-controls";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = {
  params: Promise<{ vendorId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DOC_HREF: Record<string, string> = { BILL: "/purchasing/bills", DEBIT_NOTE: "/finance/debit-notes", PAYMENT: "/finance/payments" };

export default async function VendorStatementPage({ params, searchParams }: Props) {
  const { vendorId } = await params;
  const query = await searchParams;
  const ctx = await getAccessContext();
  const breadcrumbs = ["Finance", "Statements", "Vendor"];

  if (!can(ctx, "finance.report")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={breadcrumbs} title="Vendor statement" />
        <Card><CardContent className="pt-5 text-sm text-muted">You need the finance report permission to view statements.</CardContent></Card>
      </div>
    );
  }

  const companies = await prisma.company.findMany({
    where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } },
    select: { id: true, code: true, name: true },
    orderBy: [{ isDefault: "desc" }, { code: "asc" }],
  });
  const companyId = param(query, "companyId") ?? companies[0]?.id;
  const from = param(query, "from") ?? "";
  const to = param(query, "to") ?? "";
  if (!companyId) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={breadcrumbs} title="Vendor statement" />
        <Card><CardContent className="pt-5 text-sm text-muted">You don&apos;t have access to any company.</CardContent></Card>
      </div>
    );
  }
  const statement = await vendorStatement(ctx, companyId, vendorId, { from: from || undefined, to: to || undefined }).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={[...breadcrumbs.slice(0, 2), statement.party.name]}
        title={`Statement · ${statement.party.name}`}
        subtitle={statement.party.gstin ? `GSTIN ${statement.party.gstin}` : undefined}
        actions={<Link href={`/purchasing/vendors/${vendorId}`} className="text-sm text-primary hover:underline">Vendor</Link>}
      />
      <Card>
        <CardContent className="pt-5">
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <Field label="Company">
              <Select name="companyId" defaultValue={companyId} className="min-w-48">
                {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </Select>
            </Field>
            <Field label="From"><Input type="date" name="from" defaultValue={from} /></Field>
            <Field label="To"><Input type="date" name="to" defaultValue={to} /></Field>
            <Button type="submit" size="sm" variant="secondary">Apply</Button>
          </form>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr className="border-b border-[var(--ic-border)]">
                  <th className="py-2 pr-2">Date</th>
                  <th className="py-2 pr-2">Document</th>
                  <th className="py-2 pr-2 text-right">Billed</th>
                  <th className="py-2 pr-2 text-right">Paid / debited</th>
                  <th className="py-2 text-right">Balance owed</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-[var(--ic-border)] text-muted">
                  <td className="py-2 pr-2" colSpan={4}>Opening balance{from ? ` as of ${formatDate(from)}` : ""}</td>
                  <td className="py-2 text-right">{formatMoney(statement.openingBalance)}</td>
                </tr>
                {statement.rows.length === 0 ? (
                  <tr><td colSpan={5} className="py-4 text-center text-muted">No posted bills, debit notes or payments in this period.</td></tr>
                ) : (
                  statement.rows.map((r) => (
                    <tr key={`${r.type}-${r.documentId}`} className="border-b border-[var(--ic-border)]">
                      <td className="py-2 pr-2">{formatDate(r.date)}</td>
                      <td className="py-2 pr-2">
                        <span className="text-subtle">{humanize(r.type)} </span>
                        <Link href={`${DOC_HREF[r.type]}/${r.documentId}`} className="text-primary hover:underline">{r.number ?? "—"}</Link>
                      </td>
                      <td className="py-2 pr-2 text-right">{Number(r.debit) ? formatMoney(r.debit) : ""}</td>
                      <td className="py-2 pr-2 text-right">{Number(r.credit) ? formatMoney(r.credit) : ""}</td>
                      <td className="py-2 text-right">{formatMoney(r.balance)}</td>
                    </tr>
                  ))
                )}
                <tr className="font-semibold">
                  <td className="py-2 pr-2" colSpan={4}>Closing balance</td>
                  <td className="py-2 text-right">{formatMoney(statement.closingBalance)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
