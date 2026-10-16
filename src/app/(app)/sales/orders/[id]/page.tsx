import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { Decimal } from "@/lib/money";
import { can, getAccessContext } from "@/lib/access";
import { getSalesOrder } from "@/features/sales/orders";
import { listCatalogLookups, listProducts } from "@/features/catalog/service";
import { listWarehouses } from "@/features/inventory/warehouses";
import { DeliverForm } from "@/features/inventory/deliver-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { LinesEditor } from "@/components/erp/lines-editor";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail, DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { dateInput, formatDate, formatMoney, formatQty, humanize } from "@/components/erp/format";

export default async function SalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const order = await getSalesOrder(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });

  const nothingDelivered = order.lines.every((l) => l.deliveredQty.lte(0));
  const openForChange = (order.status === "DRAFT" || order.status === "CONFIRMED") && nothingDelivered;
  const canAmend = openForChange && can(ctx, "sales_order.update");
  const [products, lookups] = canAmend && can(ctx, "product.view")
    ? await Promise.all([listProducts(ctx, { pageSize: "100", status: "ACTIVE" }), listCatalogLookups(ctx)])
    : [null, null];

  const deliverable = order.status === "CONFIRMED" || order.status === "PARTIALLY_DELIVERED";
  const canChangeWarehouse = (order.status === "DRAFT" || (order.status === "CONFIRMED" && nothingDelivered)) && can(ctx, "sales_order.update") && can(ctx, "inventory.view");
  const warehouses = canChangeWarehouse ? (await listWarehouses(ctx, order.companyId)).filter((w) => w.isActive) : [];
  const productLines = order.lines
    .filter((l) => l.product)
    .map((l) => ({ line: l, open: Decimal.max(l.quantity.sub(l.deliveredQty), 0) }));
  const openLines = productLines.filter((p) => p.open.gt(0));

  const invoices = can(ctx, "invoice.view")
    ? await prisma.salesInvoice.findMany({
        where: { organizationId: ctx.organizationId, salesOrderId: id },
        select: { id: true, number: true, status: true, grandTotal: true, invoiceDate: true },
        orderBy: { createdAt: "asc" },
      })
    : null;
  const invoiceable = ["CONFIRMED", "PARTIALLY_DELIVERED", "DELIVERED"].includes(order.status) && can(ctx, "invoice.create");

  const ordered = order.lines.reduce((sum, l) => sum + Number(l.quantity.toString()), 0);
  const delivered = order.lines.reduce((sum, l) => sum + Number(l.deliveredQty.toString()), 0);
  const percent = ordered > 0 ? Math.min(100, Math.round((delivered / ordered) * 100)) : 0;

  const details: [string, ReactNode][] = [
    ["Customer", <Link key="c" href={`/crm/customers/${order.customer.id}`} className="text-primary hover:underline">{order.customer.name}</Link>],
    ["Contact", order.contact?.fullName ?? "—"],
    ["Quotation", order.quotation ? (
      <Link key="q" href={`/sales/quotations/${order.quotation.id}`} className="text-primary hover:underline">
        {order.quotation.number}{order.quotation.revision > 1 ? ` R${order.quotation.revision}` : ""}
      </Link>
    ) : "—"],
    ["Company / branch", `${order.company.code} · ${order.branch.name}`],
    ["Order date", formatDate(order.orderDate)],
    ["Expected delivery", formatDate(order.expectedDeliveryDate)],
    ["Customer PO", order.customerPoNumber ?? "—"],
    ["Place of supply", order.placeOfSupplyState ?? "—"],
    ["Amendments", String(order.amendmentCount)],
    ["Created by", order.createdBy.name ?? order.createdBy.email],
  ];
  if (!canAmend) {
    details.push(
      ["Shipping address", order.shippingAddress ?? "—"],
      ["Delivery instructions", order.deliveryInstructions ?? "—"],
      ["Notes", order.notes ?? "—"],
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Sales", "Orders", order.number]}
        title={order.number}
        subtitle={order.customer.name}
        actions={
          <>
            <StatusBadge status={order.status} />
            <Link href={`/print/orders/${id}`} target="_blank" className="text-sm text-primary hover:underline">Print</Link>
            {order.status === "DRAFT" && can(ctx, "sales_order.update") ? (
              <ActionButton path={`/sales-orders/${id}/confirm`} label="Confirm" variant="default" />
            ) : null}
            {invoiceable ? (
              <ActionButton path={`/sales-orders/${id}/invoice`} label="Create invoice" confirm="Create a draft invoice for everything delivered (goods) or ordered (services) and not yet invoiced?" redirectTo="/finance/invoices/:id" />
            ) : null}
            {openForChange && can(ctx, "sales_order.cancel") ? (
              <ActionButton path={`/sales-orders/${id}/cancel`} label="Cancel order" prompt="Cancellation reason" variant="ghost" />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {order.status === "CANCELLED" ? (
                <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-danger">
                  Cancelled {formatDate(order.cancelledAt)}{order.cancelReason ? `: “${order.cancelReason}”` : ""}
                </p>
              ) : null}
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                {details.map(([label, value]) => (
                  <div key={label}><dt className="text-subtle">{label}</dt><dd className="whitespace-pre-line">{value}</dd></div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Fulfilment</CardTitle></CardHeader>
            <CardContent>
              <div className="mb-4 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Delivered {formatQty(delivered)} of {formatQty(ordered)}</span>
                  <span className="font-medium">{percent}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                </div>
              </div>
              {order.lines.length ? (
                <DocumentLines lines={order.lines} currency={order.currency} progressLabel="Delivered" />
              ) : (
                <p className="text-sm text-muted">No lines.</p>
              )}
              <DocumentTotals doc={order} currency={order.currency} />
            </CardContent>
          </Card>

          {canAmend ? (
            <Card>
              <CardHeader><CardTitle>{order.status === "CONFIRMED" ? "Amend order" : "Edit order"}</CardTitle></CardHeader>
              <CardContent>
                {order.status === "CONFIRMED" ? (
                  <p className="mb-3 text-xs text-muted">
                    This order is confirmed. Saving records an amendment in the history with the previous lines and total.
                    Amendments are blocked once anything is delivered.
                  </p>
                ) : null}
                <ApiForm
                  path={`/sales-orders/${id}`}
                  method="PATCH"
                  submitLabel={order.status === "CONFIRMED" ? "Save amendment" : "Save"}
                  successMessage={order.status === "CONFIRMED" ? "Amendment saved" : "Saved"}
                  className="grid gap-3 sm:grid-cols-3"
                >
                  <Field label="Customer PO number"><Input name="customerPoNumber" defaultValue={order.customerPoNumber ?? ""} data-nullable /></Field>
                  <Field label="Expected delivery"><Input type="date" name="expectedDeliveryDate" defaultValue={dateInput(order.expectedDeliveryDate)} data-nullable /></Field>
                  <Field label="Shipping address"><Input name="shippingAddress" defaultValue={order.shippingAddress ?? ""} data-nullable /></Field>
                  <Field label="Delivery instructions" className="sm:col-span-3">
                    <Textarea name="deliveryInstructions" rows={2} defaultValue={order.deliveryInstructions ?? ""} data-nullable />
                  </Field>
                  <div className="sm:col-span-3">
                    <LinesEditor
                      products={(products?.items ?? []).map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: p.salesPrice.toString(), taxRateId: p.taxRateId }))}
                      taxRates={(lookups?.taxRates ?? []).filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name, rate: t.rate.toString() }))}
                      initial={order.lines.map((l) => ({
                        productId: l.productId ?? "",
                        description: l.description,
                        quantity: l.quantity.toString(),
                        unitPrice: l.unitPrice.toString(),
                        discountPercent: l.discountPercent.isZero() ? "" : l.discountPercent.toString(),
                        taxRateId: l.taxRateId ?? "none",
                      }))}
                    />
                  </div>
                  <Field label="Notes" className="sm:col-span-3"><Textarea name="notes" rows={2} defaultValue={order.notes ?? ""} data-nullable /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Stock &amp; deliveries</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div>
                <p className="text-subtle">Warehouse</p>
                {canChangeWarehouse ? (
                  <ApiForm path={`/sales-orders/${id}`} method="PATCH" submitLabel="Change warehouse" successMessage="Warehouse updated" className="mt-1 space-y-2">
                    <Select name="warehouseId" defaultValue={order.warehouse?.id ?? ""} data-nullable aria-label="Warehouse">
                      <option value="">No warehouse</option>
                      {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
                    </Select>
                  </ApiForm>
                ) : (
                  <p>{order.warehouse ? `${order.warehouse.code} · ${order.warehouse.name}` : "—"}</p>
                )}
              </div>

              {productLines.length ? (
                <table className="w-full">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr><th className="py-1 pr-2">Item</th><th className="py-1 pr-2 text-right">Ordered</th><th className="py-1 pr-2 text-right">Delivered</th><th className="py-1 pr-2 text-right">Reserved</th><th className="py-1 text-right">Open</th></tr>
                  </thead>
                  <tbody>
                    {productLines.map(({ line, open }) => (
                      <tr key={line.id} className="border-t border-[var(--ic-border)]">
                        <td className="py-1 pr-2">{line.product?.sku}</td>
                        <td className="py-1 pr-2 text-right">{formatQty(line.quantity)}</td>
                        <td className="py-1 pr-2 text-right">{formatQty(line.deliveredQty)}</td>
                        <td className="py-1 pr-2 text-right" title="Base units">{line.reservation ? formatQty(line.reservation.quantity) : "—"}</td>
                        <td className="py-1 text-right font-medium">{formatQty(open)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-muted">No product lines.</p>}

              {deliverable && can(ctx, "sales_order.update") ? (
                <ActionButton path={`/sales-orders/${id}/reserve`} label="Reserve available stock" />
              ) : null}

              {deliverable && openLines.length && can(ctx, "inventory.create") && can(ctx, "inventory.post") ? (
                <div className="space-y-2 border-t border-[var(--ic-border)] pt-3">
                  <p className="font-medium">Deliver</p>
                  <DeliverForm
                    orderId={id}
                    lines={openLines.map(({ line, open }) => ({
                      id: line.id,
                      label: `${line.product?.sku} · ${line.description}`,
                      open: open.toString(),
                      uom: line.uom?.code ?? "",
                      needsLot: Boolean(line.product?.trackInventory && line.product.trackingMode !== "NONE"),
                    }))}
                  />
                </div>
              ) : null}

              {order.stockEntries.length ? (
                <ul className="space-y-1 border-t border-[var(--ic-border)] pt-3">
                  {order.stockEntries.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-2">
                      <Link href={`/inventory/entries/${e.id}`} className="text-primary hover:underline">{e.number}</Link>
                      <span className="text-muted">{humanize(e.type)}</span>
                      <StatusBadge status={e.status} />
                      <span className="text-2xs text-subtle">{formatDate(e.postedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
          {invoices ? (
            <Card>
              <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
              <CardContent>
                {invoices.length === 0 ? <p className="text-sm text-muted">Not invoiced yet.</p> : (
                  <ul className="space-y-1 text-sm">
                    {invoices.map((inv) => (
                      <li key={inv.id} className="flex flex-wrap items-center gap-2">
                        <Link href={`/finance/invoices/${inv.id}`} className="text-primary hover:underline">{inv.number ?? "Draft"}</Link>
                        <StatusBadge status={inv.status} />
                        <span className="text-muted">{formatMoney(inv.grandTotal, order.currency)}</span>
                        <span className="text-2xs text-subtle">{formatDate(inv.invoiceDate)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="sales_order" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
