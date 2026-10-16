import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getProduct, listCatalogLookups } from "@/features/catalog/service";
import { getStockLevels } from "@/features/inventory/stock";
import { ConversionsInput } from "@/features/inventory/json-inputs";
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
  const [lookups, stock, conversions] = await Promise.all([
    canEdit ? listCatalogLookups(ctx) : null,
    can(ctx, "inventory.view") && product.type === "GOODS" ? getStockLevels(ctx, { productId: id }) : null,
    prisma.uomConversion.findMany({ where: { productId: id, organizationId: ctx.organizationId }, include: { uom: true }, orderBy: { factor: "asc" } }),
  ]);

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
                  <Field label="Tracking">
                    <Select name="trackingMode" defaultValue={product.trackingMode}>
                      <option value="NONE">No lots</option>
                      <option value="BATCH">Batch / lot</option>
                      <option value="SERIAL">Serial number</option>
                    </Select>
                  </Field>
                  <Field label="Reorder level" hint="Available at or below this suggests a reorder"><Input name="reorderLevel" inputMode="decimal" defaultValue={product.reorderLevel?.toString() ?? ""} data-nullable /></Field>
                  <Field label="Reorder quantity" hint="Blank orders up to the level"><Input name="reorderQty" inputMode="decimal" defaultValue={product.reorderQty?.toString() ?? ""} data-nullable /></Field>
                  <div className="flex flex-wrap gap-4 text-sm sm:col-span-3">
                    <label className="flex items-center gap-2"><input type="checkbox" name="trackInventory" defaultChecked={product.trackInventory} /> Track stock</label>
                    <label className="flex items-center gap-2"><input type="checkbox" name="hasExpiry" defaultChecked={product.hasExpiry} /> Has expiry dates</label>
                  </div>
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
                  <div><dt className="text-subtle">Stock tracking</dt><dd>{product.trackInventory ? humanize(product.trackingMode === "NONE" ? "TRACKED" : product.trackingMode) : "Not tracked"}{product.hasExpiry ? " · expiry" : ""}</dd></div>
                  <div><dt className="text-subtle">Reorder level / qty</dt><dd>{formatQty(product.reorderLevel)} / {formatQty(product.reorderQty)}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-subtle">Description</dt><dd className="whitespace-pre-line">{product.description ?? "—"}</dd></div>
                </dl>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {stock ? (
            <Card>
              <CardHeader><CardTitle>Stock</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {stock.length ? (
                  <table className="w-full">
                    <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                      <tr><th className="py-1 pr-2">Warehouse</th><th className="py-1 pr-2 text-right">On hand</th><th className="py-1 pr-2 text-right">Reserved</th><th className="py-1 text-right">Available</th></tr>
                    </thead>
                    <tbody>
                      {stock.map((s) => (
                        <tr key={s.warehouse.id} className="border-t border-[var(--ic-border)]">
                          <td className="py-1 pr-2">{s.warehouse.code}</td>
                          <td className="py-1 pr-2 text-right">{formatQty(s.onHand)}</td>
                          <td className="py-1 pr-2 text-right">{formatQty(s.reserved)}</td>
                          <td className={`py-1 text-right font-medium ${Number(s.available) <= 0 ? "text-danger" : ""}`}>{formatQty(s.available)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="text-muted">No stock recorded.</p>}
                <Link href="/inventory/stock" className="text-primary hover:underline">All stock levels</Link>
              </CardContent>
            </Card>
          ) : null}
          {lookups || conversions.length ? (
            <Card>
              <CardHeader><CardTitle>Unit conversions</CardTitle></CardHeader>
              <CardContent className="text-sm">
                {lookups ? (
                  <ApiForm path={`/products/${id}/uom-conversions`} method="PUT" submitLabel="Save conversions" successMessage="Conversions saved">
                    <ConversionsInput
                      initial={conversions.map((c) => ({ uomId: c.uomId, factor: c.factor.toString() }))}
                      uoms={lookups.uoms.filter((u) => u.id !== product.uomId).map((u) => ({ id: u.id, code: u.code }))}
                      baseUom={product.uom.code}
                    />
                    <p className="text-2xs text-subtle">Clear a factor to remove that unit.</p>
                  </ApiForm>
                ) : (
                  <ul className="space-y-0.5">
                    {conversions.map((c) => <li key={c.id}>1 {c.uom.code} = {formatQty(c.factor)} {product.uom.code}</li>)}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="product" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
