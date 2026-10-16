import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getInvoice, outstanding } from "@/features/finance/receivables";
import { ReceiptForm } from "@/features/finance/receipt-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { param } from "@/components/erp/list-controls";
import { dateInput } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewReceiptPage({ searchParams }: Props) {
  const params = await searchParams;
  const invoiceId = param(params, "invoiceId") ?? "";
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Finance", "Receipts", "New"]} title="Record receipt" subtitle="Receipts post immediately. Any amount not allocated stays as on-account credit." />;

  if (!can(ctx, "receipt.create")) {
    return (
      <div className="space-y-4">
        {header}
        <p className="text-sm text-muted">You don&apos;t have permission to record receipts.</p>
      </div>
    );
  }

  const canSeeInvoices = can(ctx, "invoice.view");
  const invoice = invoiceId && canSeeInvoices
    ? await getInvoice(ctx, invoiceId).catch((e) => {
        if (isAppError(e) && e.status === 404) return null;
        throw e;
      })
    : null;
  const customerId = invoice?.customerId ?? param(params, "customerId") ?? "";
  const companyIds = [...ctx.companies.keys()];

  const [companies, customers, banks, invoices] = await Promise.all([
    prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: companyIds } }, select: { id: true, code: true, name: true }, orderBy: [{ isDefault: "desc" }, { code: "asc" }] }),
    prisma.customer.findMany({
      where: { organizationId: ctx.organizationId, OR: [{ status: "ACTIVE" }, ...(customerId ? [{ id: customerId }] : [])] },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.bankAccount.findMany({
      where: { organizationId: ctx.organizationId, companyId: { in: companyIds }, isActive: true },
      include: { company: { select: { code: true } } },
      orderBy: { name: "asc" },
    }),
    customerId && canSeeInvoices
      ? prisma.salesInvoice.findMany({
          where: { organizationId: ctx.organizationId, customerId, companyId: { in: companyIds }, status: "POSTED" },
          orderBy: { dueDate: "asc" },
          take: 200,
        })
      : [],
  ]);
  const open = invoices
    .map((i) => ({ i, due: outstanding(i) }))
    .filter(({ due }) => due.gt(0))
    .map(({ i, due }) => ({ id: i.id, companyId: i.companyId, number: i.number ?? "—", dueDate: dateInput(i.dueDate), grandTotal: i.grandTotal.toString(), outstanding: due.toFixed(2) }));
  const prefill = invoice && invoice.status === "POSTED" && Number(invoice.outstanding) > 0 ? { invoiceId: invoice.id, amount: invoice.outstanding } : undefined;

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          {companies.length === 0 ? (
            <p className="text-sm text-muted">You don&apos;t have access to any company. Ask an administrator to grant one.</p>
          ) : banks.length === 0 ? (
            <p className="text-sm text-muted">No active bank or cash accounts yet. A finance administrator needs to set them up first.</p>
          ) : (
            <ReceiptForm
              companies={companies.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
              customers={customers}
              banks={banks.map((b) => ({ id: b.id, companyId: b.companyId, label: `${b.company.code} · ${b.name}` }))}
              invoices={open}
              customerId={customerId}
              defaultCompanyId={invoice?.companyId ?? companies[0].id}
              prefill={prefill}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
