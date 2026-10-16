import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listExpenseCategories } from "@/features/finance/expenses";
import { ExpenseClaimForm } from "@/features/finance/expense-claim-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { dateInput } from "@/components/erp/format";

export default async function NewExpenseClaimPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Finance", "Expenses", "New"]} title="New expense claim" subtitle="Save as a draft, attach receipts, then submit for approval." />;
  if (!can(ctx, "expense.create")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to create expense claims.</p></div>;
  }

  const companies = await prisma.company.findMany({
    where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } },
    select: { id: true, code: true, name: true },
    orderBy: [{ isDefault: "desc" }, { code: "asc" }],
  });
  const categories = (await Promise.all(companies.map((c) => listExpenseCategories(ctx, c.id))))
    .flat()
    .filter((c) => c.isActive)
    .map((c) => ({ id: c.id, companyId: c.companyId, name: c.name }));

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          {companies.length === 0 ? (
            <p className="text-sm text-muted">You don&apos;t have access to any company. Ask an administrator to grant one.</p>
          ) : (
            <ExpenseClaimForm companies={companies.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))} categories={categories} today={dateInput(new Date())} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
