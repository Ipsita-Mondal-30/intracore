import { can, getAccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import { listCustomers } from "@/features/customers/service";
import { listCatalogLookups, listProducts } from "@/features/catalog/service";
import { listWarehouses } from "@/features/inventory/warehouses";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { LinesEditor } from "@/components/erp/lines-editor";
import { param } from "@/components/erp/list-controls";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewSalesOrderPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Sales", "Orders", "New"]} title="New sales order" subtitle="Prices and GST fall back to customer and product defaults when left blank." />;

  if (!can(ctx, "sales_order.create")) {
    return (
      <div className="space-y-4">
        {header}
        <Card><CardContent className="pt-5 text-sm text-muted">You don&apos;t have permission to create sales orders.</CardContent></Card>
      </div>
    );
  }

  const canCatalog = can(ctx, "product.view");
  const [companies, customers, products, lookups, warehouses] = await Promise.all([
    can(ctx, "company.view") ? listCompanies(ctx) : [],
    // ponytail: first 100 active customers; switch to a search combobox when tenants outgrow it
    can(ctx, "customer.view") ? listCustomers(ctx, { status: "ACTIVE", pageSize: "100" }) : null,
    canCatalog ? listProducts(ctx, { pageSize: "100", status: "ACTIVE" }) : null,
    canCatalog ? listCatalogLookups(ctx) : null,
    can(ctx, "inventory.view") ? listWarehouses(ctx) : [],
  ]);
  const branches = companies.flatMap((c) => c.branches.filter((b) => b.isActive).map((b) => ({ value: `${c.id}:${b.id}`, label: `${c.code} · ${b.name}` })));
  const customerId = param(params, "customerId") ?? "";

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader><CardTitle>Order</CardTitle></CardHeader>
        <CardContent>
          {branches.length === 0 || !customers?.items.length ? (
            <p className="text-sm text-muted">
              {branches.length === 0 ? "You need access to at least one active branch to create orders." : "Create a customer first."}
            </p>
          ) : (
            <ApiForm path="/sales-orders" submitLabel="Create order" redirect="/sales/orders/:id" successMessage="Order created" className="grid gap-3 sm:grid-cols-3">
              <Field label="Company / branch">
                <Select name="branch" data-split="companyId,branchId" required>
                  {branches.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                </Select>
              </Field>
              <Field label="Customer">
                <Select name="customerId" defaultValue={customerId} required>
                  <option value="" disabled>Select a customer…</option>
                  {customers.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Customer PO number"><Input name="customerPoNumber" /></Field>
              {warehouses.length ? (
                <Field label="Warehouse" hint="Must belong to the order's company">
                  <Select name="warehouseId" data-nullable defaultValue="">
                    <option value="">Branch default</option>
                    {warehouses.filter((w) => w.isActive).map((w) => <option key={w.id} value={w.id}>{w.company.code} · {w.code} · {w.name}</option>)}
                  </Select>
                </Field>
              ) : null}
              <Field label="Expected delivery"><Input type="date" name="expectedDeliveryDate" /></Field>
              <Field label="Shipping address" className="sm:col-span-2"><Input name="shippingAddress" /></Field>
              <Field label="Delivery instructions" className="sm:col-span-3"><Textarea name="deliveryInstructions" rows={2} /></Field>
              <div className="sm:col-span-3">
                <LinesEditor
                  products={(products?.items ?? []).map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: p.salesPrice.toString(), taxRateId: p.taxRateId }))}
                  taxRates={(lookups?.taxRates ?? []).filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, rate: t.rate.toString() }))}
                />
              </div>
              <Field label="Notes" className="sm:col-span-3"><Textarea name="notes" rows={2} /></Field>
            </ApiForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
