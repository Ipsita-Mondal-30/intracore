import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { dec } from "@/lib/money";
import { can, getAccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import { listCatalogLookups, listProducts } from "@/features/catalog/service";
import { getPurchaseOrder } from "@/features/purchasing/purchase-orders";
import { BillForm, type BillableLine } from "@/features/purchasing/bill-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { LinesEditor } from "@/components/erp/lines-editor";
import { param } from "@/components/erp/list-controls";
import { dateInput } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const breadcrumbs = ["Purchasing", "Vendor bills", "New"];

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={breadcrumbs} title="New vendor bill" />
      <p className="text-sm text-muted">{children}</p>
    </div>
  );
}

export default async function NewVendorBillPage({ searchParams }: Props) {
  const params = await searchParams;
  const purchaseOrderId = param(params, "purchaseOrderId");
  const ctx = await getAccessContext();
  const today = dateInput(new Date());

  if (!can(ctx, "vendor_bill.create")) return <Message>You don&apos;t have permission to create vendor bills.</Message>;

  if (purchaseOrderId) {
    if (!can(ctx, "purchase_order.view")) return <Message>You don&apos;t have permission to view purchase orders.</Message>;
    const po = await getPurchaseOrder(ctx, purchaseOrderId).catch((e) => {
      if (isAppError(e) && e.status === 404) notFound();
      throw e;
    });
    const lines: BillableLine[] = po.lines
      .map((l) => ({ l, billable: dec(l.receivedQty).sub(l.returnedQty).sub(l.billedQty) }))
      .filter(({ billable }) => billable.gt(0))
      .map(({ l, billable }) => ({
        id: l.id,
        description: l.description,
        sku: l.product.sku,
        uom: l.uom?.code ?? "",
        billable: billable.toString(),
        unitPrice: l.unitPrice.toString(),
      }));

    return (
      <div className="space-y-4">
        <PageHeader
          breadcrumbs={breadcrumbs}
          title="New vendor bill"
          subtitle={`Against ${po.number} · ${po.vendor.name} · ${po.company.code} · ${po.branch.name}`}
        />
        <Card>
          <CardContent className="pt-5">
            {lines.length === 0 ? (
              <p className="text-sm text-muted">
                Nothing left to bill on <Link href={`/purchasing/orders/${po.id}`} className="text-primary hover:underline">{po.number}</Link>. Receive goods first.
              </p>
            ) : (
              <BillForm purchaseOrderId={po.id} companyId={po.companyId} branchId={po.branchId} vendorId={po.vendorId} lines={lines} today={today} />
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const [companies, vendors, products, lookups] = await Promise.all([
    listCompanies(ctx),
    prisma.vendor.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" }, take: 500 }),
    can(ctx, "product.view") ? listProducts(ctx, { pageSize: "100", status: "ACTIVE" }) : null,
    can(ctx, "product.view") ? listCatalogLookups(ctx) : null,
  ]);
  const branches = companies.flatMap((c) => c.branches.map((b) => ({ value: `${c.id}:${b.id}`, label: `${c.code} · ${b.name}` })));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={breadcrumbs}
        title="New vendor bill"
        subtitle="A bill without a purchase order. To bill received goods, use “Create bill” on the purchase order."
      />
      <Card>
        <CardContent className="pt-5">
          {branches.length === 0 ? (
            <p className="text-sm text-muted">You don&apos;t have access to any company branch. Ask an administrator to grant one.</p>
          ) : vendors.length === 0 ? (
            <p className="text-sm text-muted">
              No active vendors yet. <Link href="/purchasing/vendors" className="text-primary hover:underline">Create a vendor</Link> first.
            </p>
          ) : (
            <ApiForm path="/vendor-bills" submitLabel="Create bill" redirect="/purchasing/bills/:id" successMessage="Bill created">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Company / branch">
                  <Select name="companyBranch" data-split="companyId,branchId" required>
                    {branches.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </Select>
                </Field>
                <Field label="Vendor">
                  <Select name="vendorId" required>
                    <option value="">Select a vendor…</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}{v.code ? ` (${v.code})` : ""}</option>)}
                  </Select>
                </Field>
                <Field label="Vendor invoice number"><Input name="vendorInvoiceNumber" required maxLength={64} /></Field>
                <Field label="Bill date"><Input type="date" name="billDate" defaultValue={today} required /></Field>
                <Field label="Due date" hint="Defaults to the vendor's payment terms"><Input type="date" name="dueDate" /></Field>
              </div>
              <LinesEditor
                products={(products?.items ?? []).map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: p.purchasePrice.toString(), taxRateId: p.taxRateId }))}
                taxRates={(lookups?.taxRates ?? []).filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, rate: t.rate.toString() }))}
              />
              <Field label="Notes"><Textarea name="notes" rows={3} /></Field>
            </ApiForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
