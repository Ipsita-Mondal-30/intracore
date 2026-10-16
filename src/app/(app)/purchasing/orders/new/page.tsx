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
import { LinesEditor, type ProductOption } from "@/components/erp/lines-editor";
import { param } from "@/components/erp/list-controls";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewPurchaseOrderPage({ searchParams }: Props) {
  const params = await searchParams;
  const vendorId = param(params, "vendorId") ?? "";
  const productId = param(params, "productId") ?? "";
  const quantity = param(params, "quantity") ?? "1";
  const ctx = await getAccessContext();

  if (!can(ctx, "purchase_order.create")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Purchasing", "Purchase orders", "New"]} title="New purchase order" />
        <p className="text-sm text-muted">You don&apos;t have permission to create purchase orders.</p>
      </div>
    );
  }

  const canProducts = can(ctx, "product.view");
  const [companies, warehouses, vendors, products, lookups, prefill] = await Promise.all([
    listCompanies(ctx),
    prisma.warehouse.findMany({
      where: { organizationId: ctx.organizationId, companyId: { in: [...ctx.companies.keys()] }, isActive: true },
      include: { company: { select: { code: true } } },
      orderBy: [{ companyId: "asc" }, { code: "asc" }],
    }),
    prisma.vendor.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" }, take: 500 }),
    canProducts ? listProducts(ctx, { pageSize: "100", status: "ACTIVE" }) : null,
    canProducts ? listCatalogLookups(ctx) : null,
    productId ? prisma.product.findFirst({ where: { id: productId, organizationId: ctx.organizationId } }) : null,
  ]);
  const branches = companies.flatMap((c) => c.branches.map((b) => ({ value: `${c.id}:${b.id}`, label: `${c.code} · ${b.name}` })));

  const productOptions = new Map<string, ProductOption>();
  for (const p of [...(prefill ? [prefill] : []), ...(products?.items ?? [])]) {
    productOptions.set(p.id, { id: p.id, sku: p.sku, name: p.name, price: p.purchasePrice.toString(), taxRateId: p.taxRateId });
  }
  const initial = prefill
    ? [{ productId: prefill.id, description: "", quantity, unitPrice: "", discountPercent: "", taxRateId: "" }]
    : [];

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Purchasing", "Purchase orders", "New"]} title="New purchase order" subtitle="Prices default to each product's purchase price." />

      <Card>
        <CardContent className="pt-5">
          {branches.length === 0 ? (
            <p className="text-sm text-muted">You don&apos;t have access to any company branch. Ask an administrator to grant one.</p>
          ) : warehouses.length === 0 ? (
            <p className="text-sm text-muted">No active warehouse in your companies. Ask an administrator to set one up.</p>
          ) : vendors.length === 0 ? (
            <p className="text-sm text-muted">
              No active vendors yet. <Link href="/purchasing/vendors" className="text-primary hover:underline">Create a vendor</Link> first.
            </p>
          ) : (
            <ApiForm path="/purchase-orders" submitLabel="Create purchase order" redirect="/purchasing/orders/:id" successMessage="Purchase order created">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Company / branch">
                  <Select name="companyBranch" data-split="companyId,branchId" required>
                    {branches.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </Select>
                </Field>
                <Field label="Warehouse" hint="Must belong to the selected company">
                  <Select name="warehouseId" required>
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.company.code} · {w.code} ({w.name})</option>)}
                  </Select>
                </Field>
                <Field label="Vendor">
                  <Select name="vendorId" defaultValue={vendorId} required>
                    <option value="">Select a vendor…</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}{v.code ? ` (${v.code})` : ""}</option>)}
                  </Select>
                </Field>
                <Field label="Expected date"><Input type="date" name="expectedDate" /></Field>
                <Field label="Supplier state" hint="GST state code, e.g. 29. Defaults to the vendor's state.">
                  <Input name="supplierState" inputMode="numeric" pattern="[0-9]{2}" maxLength={2} />
                </Field>
              </div>
              <LinesEditor
                products={[...productOptions.values()]}
                taxRates={(lookups?.taxRates ?? []).filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, rate: t.rate.toString() }))}
                initial={initial}
              />
              <Field label="Notes"><Textarea name="notes" rows={3} /></Field>
            </ApiForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
