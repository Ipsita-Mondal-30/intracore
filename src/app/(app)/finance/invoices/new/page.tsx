import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import { listCatalogLookups, listProducts } from "@/features/catalog/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { LinesEditor } from "@/components/erp/lines-editor";
import { param } from "@/components/erp/list-controls";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewInvoicePage({ searchParams }: Props) {
  const params = await searchParams;
  const customerId = param(params, "customerId") ?? "";
  const ctx = await getAccessContext();

  if (!can(ctx, "invoice.create")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Invoices", "New"]} title="New invoice" />
        <p className="text-sm text-muted">You don&apos;t have permission to create invoices.</p>
      </div>
    );
  }

  const [companies, customers, products, lookups] = await Promise.all([
    listCompanies(ctx),
    prisma.customer.findMany({
      where: { organizationId: ctx.organizationId, OR: [{ status: "ACTIVE" }, ...(customerId ? [{ id: customerId }] : [])] },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 200,
    }),
    can(ctx, "product.view") ? listProducts(ctx, { pageSize: "100", status: "ACTIVE" }) : null,
    can(ctx, "product.view") ? listCatalogLookups(ctx) : null,
  ]);
  const branches = companies.flatMap((c) => c.branches.map((b) => ({ value: `${c.id}:${b.id}`, label: `${c.code} · ${b.name}` })));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Invoices", "New"]}
        title="New invoice"
        subtitle="Saved as a draft. The invoice number is assigned and the journal written when you post it."
      />

      <Card>
        <CardContent className="pt-5">
          {branches.length === 0 ? (
            <p className="text-sm text-muted">You don&apos;t have access to any company branch. Ask an administrator to grant one.</p>
          ) : customers.length === 0 ? (
            <p className="text-sm text-muted">
              No customers yet. <Link href="/crm/customers" className="text-primary hover:underline">Create a customer</Link> first.
            </p>
          ) : (
            <ApiForm path="/sales-invoices" submitLabel="Create draft invoice" redirect="/finance/invoices/:id" successMessage="Draft invoice created">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Company / branch">
                  <Select name="companyBranch" data-split="companyId,branchId" required>
                    {branches.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </Select>
                </Field>
                <Field label="Customer">
                  <Select name="customerId" defaultValue={customerId} required>
                    <option value="">Select a customer…</option>
                    {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Place of supply" hint="GST state code, e.g. 29. Defaults to the customer's state.">
                  <Input name="placeOfSupplyState" inputMode="numeric" pattern="[0-9]{2}" maxLength={2} />
                </Field>
                <Field label="Invoice date" hint="Defaults to today">
                  <Input type="date" name="invoiceDate" />
                </Field>
                <Field label="Due date" hint="Defaults to the customer's payment terms">
                  <Input type="date" name="dueDate" />
                </Field>
              </div>
              <LinesEditor
                products={(products?.items ?? []).map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: p.salesPrice.toString(), taxRateId: p.taxRateId }))}
                taxRates={(lookups?.taxRates ?? []).filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, rate: t.rate.toString() }))}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Terms"><Textarea name="terms" rows={3} /></Field>
                <Field label="Notes"><Textarea name="notes" rows={3} /></Field>
              </div>
            </ApiForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
