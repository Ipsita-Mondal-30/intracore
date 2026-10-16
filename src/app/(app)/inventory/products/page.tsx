import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listCatalogLookups, listProducts } from "@/features/catalog/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatMoney, formatQty, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ProductsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const canCreate = can(ctx, "product.create");
  const [page, lookups] = await Promise.all([
    listProducts(ctx, listParams(params, ["status", "type"])),
    canCreate ? listCatalogLookups(ctx) : null,
  ]);

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Inventory", "Products"]} title="Products" subtitle="Goods and services you buy and sell." />

      {lookups ? (
        <Card>
          <CardHeader><CardTitle>New product</CardTitle></CardHeader>
          <CardContent>
            {lookups.uoms.length === 0 ? (
              <p className="text-sm text-muted">
                Add a unit of measure in <Link href="/settings/catalog" className="text-primary hover:underline">catalog settings</Link> first.
              </p>
            ) : (
              <ApiForm path="/products" submitLabel="Create product" redirect="/inventory/products/:id" className="grid gap-3 sm:grid-cols-4">
                <Field label="SKU"><Input name="sku" required /></Field>
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="Type">
                  <Select name="type" defaultValue="GOODS">
                    <option value="GOODS">Goods</option>
                    <option value="SERVICE">Service</option>
                  </Select>
                </Field>
                <Field label="Unit">
                  <Select name="uomId" required>
                    {lookups.uoms.map((u) => <option key={u.id} value={u.id}>{u.code} · {u.name}</option>)}
                  </Select>
                </Field>
                <Field label="Tax rate">
                  <Select name="taxRateId" defaultValue="" data-nullable>
                    <option value="">No tax</option>
                    {lookups.taxRates.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </Field>
                <Field label="Category">
                  <Select name="categoryId" defaultValue="" data-nullable>
                    <option value="">None</option>
                    {lookups.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="HSN / SAC"><Input name="hsnCode" /></Field>
                <Field label="Barcode"><Input name="barcode" /></Field>
                <Field label="Sales price"><Input name="salesPrice" inputMode="decimal" placeholder="0.00" /></Field>
                <Field label="Purchase price"><Input name="purchasePrice" inputMode="decimal" placeholder="0.00" /></Field>
                <Field label="Description" className="sm:col-span-2"><Textarea name="description" rows={1} /></Field>
              </ApiForm>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search name, SKU, barcode, HSN…"
            filters={[
              { name: "type", label: "Type", options: ["GOODS", "SERVICE"].map((v) => ({ value: v, label: humanize(v) })) },
              { name: "status", label: "Status", options: ["ACTIVE", "INACTIVE", "ARCHIVED"].map((v) => ({ value: v, label: humanize(v) })) },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "sku", label: "SKU" },
              { key: "name", label: "Name" },
              { key: "type", label: "Type" },
              { key: "uom", label: "Unit" },
              { key: "tax", label: "Tax" },
              { key: "price", label: "Sales price" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") ? "No products match your search." : "No products yet. Create one above."}
          >
            {page.items.length
              ? page.items.map((p) => (
                  <RecordsTableRow key={p.id}>
                    <RecordsTableCell>
                      <Link href={`/inventory/products/${p.id}`} className="font-medium text-primary hover:underline">{p.sku}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{p.name}</RecordsTableCell>
                    <RecordsTableCell>{humanize(p.type)}</RecordsTableCell>
                    <RecordsTableCell>{p.uom.code}</RecordsTableCell>
                    <RecordsTableCell>{p.taxRate ? `${formatQty(p.taxRate.rate)}%` : "—"}</RecordsTableCell>
                    <RecordsTableCell>{formatMoney(p.salesPrice)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={p.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/inventory/products" />
        </CardContent>
      </Card>
    </div>
  );
}
