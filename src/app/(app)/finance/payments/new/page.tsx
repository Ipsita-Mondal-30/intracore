import { prisma } from "@/lib/db/prisma";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { billOutstanding } from "@/features/finance/payables";
import { PaymentForm, type OpenBill } from "@/features/finance/payment-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { param } from "@/components/erp/list-controls";
import { dateInput } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewVendorPaymentPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Finance", "Vendor payments", "New"]} title="Record vendor payment" subtitle="Payments are posted immediately." />;
  if (!can(ctx, "payment.create")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to record vendor payments.</p></div>;
  }

  const companyIds = [...ctx.companies.keys()];
  const [companies, vendors, bankAccounts, posted] = await Promise.all([
    prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: companyIds } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
    prisma.vendor.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.organizationId, companyId: { in: companyIds }, isActive: true }, select: { id: true, companyId: true, name: true }, orderBy: { name: "asc" } }),
    // ponytail: oldest 1000 posted bills in scope, filtered to open ones here; fetch per vendor if that ceiling is hit.
    prisma.vendorBill.findMany({ where: { AND: [companyScopeWhere(ctx), { status: "POSTED" }] }, orderBy: { billDate: "asc" }, take: 1000 }),
  ]);
  const bills: OpenBill[] = posted
    .map((b) => ({ b, due: billOutstanding(b) }))
    .filter(({ due }) => due.gt(0))
    .map(({ b, due }) => ({
      id: b.id,
      number: b.number,
      vendorInvoiceNumber: b.vendorInvoiceNumber,
      companyId: b.companyId,
      vendorId: b.vendorId,
      billDate: b.billDate.toISOString(),
      dueDate: b.dueDate?.toISOString() ?? null,
      outstanding: due.toFixed(2),
    }));
  const billId = param(params, "billId");
  const preselected = billId ? bills.find((b) => b.id === billId) : undefined;

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          {companies.length === 0 ? (
            <p className="text-sm text-muted">You don&apos;t have access to any company. Ask an administrator to grant one.</p>
          ) : (
            <PaymentForm
              companies={companies.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
              vendors={vendors}
              bankAccounts={bankAccounts}
              bills={bills}
              initial={preselected ? { companyId: preselected.companyId, vendorId: preselected.vendorId, billId: preselected.id, amount: preselected.outstanding } : undefined}
              today={dateInput(new Date())}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
