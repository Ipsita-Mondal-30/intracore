import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getProduct, listCatalogLookups } from "@/features/catalog/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatMoney, formatQty, humanize } from "@/components/erp/format";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const product = await getProduct(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canEdit = can(ctx, "product.update");
  const lookups = canEdit ? await listCatalogLookups(ctx) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Inventory", "Products", product.sku]}
        title={product.name}
        subtitle={[product.sku, humanize(product.type), product.hsnCode && `HSN ${product.hsnCode}`].filter(Boolean).join(" · ")}
        actions={
          <>
            <StatusBadge status={product.status} />
            {can(ctx, "product.delete") && product.status !== "ARCHIVED" ? (
              <ActionButton path={`/products/${id}`} method="PATCH" label="Archive" body={{ status: "ARCHIVED" }} confirm="Archive this product?" variant="ghost" />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              {lookups ? (
                <ApiForm path={`/products/${id}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="SKU"><Input name="sku" defaultValue={product.sku} required /></Field>
                  <Field label="Name"><Input name="name" defaultValue={product.name} required /></Field>
                  <Field label="Type">
                    <Select name="type" defaultValue={product.type}>
                      <option value="GOODS">Goods</option>
                      <option value="SERVICE">Service</option>
                    </Select>
                  </Field>
                  <Field label="Unit">
                    <Select name="uomId" defaultValue={product.uomId}>
                      {lookups.uoms.map((u) => <option key={u.id} value={u.id}>{u.code} · {u.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Tax rate">
                    <Select name="taxRateId" defaultValue={product.taxRateId ?? ""} data-nullable>
                      <option value="">No tax</option>
                      {lookups.taxRates
                        .filter((t) => t.isActive || t.id === product.taxRateId)
                        .map((t) => <option key={t.id} value={t.id}>{t.name}{t.isActive ? "" : " (inactive)"}</option>)}
                    </Select>
                  </Field>
                  <Field label="Category">
                    <Select name="categoryId" defaultValue={product.categoryId ?? ""} data-nullable>
                      <option value="">None</option>
                      {lookups.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="HSN / SAC"><Input name="hsnCode" defaultValue={product.hsnCode ?? ""} data-nullable /></Field>
                  <Field label="Barcode"><Input name="barcode" defaultValue={product.barcode ?? ""} data-nullable /></Field>
                  <Field label="Status">
                    <Select name="status" defaultValue={product.status}>
                      <option value="ACTIVE">Active</option>
                      <option value="INACTIVE">Inactive</option>
                      {product.status === "ARCHIVED" ? <option value="ARCHIVED">Archived</option> : null}
                    </Select>
                  </Field>
                  <Field label="Sales price"><Input name="salesPrice" inputMode="decimal" defaultValue={product.salesPrice.toString()} /></Field>
                  <Field label="Purchase price"><Input name="purchasePrice" inputMode="decimal" defaultValue={product.purchasePrice.toString()} /></Field>
                  <Field label="Description" className="sm:col-span-3"><Textarea name="description" rows={3} defaultValue={product.description ?? ""} data-nullable /></Field>
                </ApiForm>
              ) : (
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-subtle">Unit</dt><dd>{product.uom.code}</dd></div>
                  <div><dt className="text-subtle">Category</dt><dd>{product.category?.name ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Tax</dt><dd>{product.taxRate ? `${product.taxRate.name} (${formatQty(product.taxRate.rate)}%)` : "—"}</dd></div>
                  <div><dt className="text-subtle">Barcode</dt><dd>{product.barcode ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Sales price</dt><dd>{formatMoney(product.salesPrice)}</dd></div>
                  <div><dt className="text-subtle">Purchase price</dt><dd>{formatMoney(product.purchasePrice)}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-subtle">Description</dt><dd className="whitespace-pre-line">{product.description ?? "—"}</dd></div>
                </dl>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="product" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
