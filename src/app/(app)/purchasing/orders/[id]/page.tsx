import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { dec } from "@/lib/money";
import { can, getAccessContext } from "@/lib/access";
import { getPurchaseOrder } from "@/features/purchasing/purchase-orders";
import { listCatalogLookups, listProducts } from "@/features/catalog/service";
import { ReceiveForm, type ReceivableLine } from "@/features/purchasing/receive-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { LinesEditor, type ProductOption } from "@/components/erp/lines-editor";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail, DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { dateInput, formatDate, formatDateTime, formatMoney, formatQty, humanize } from "@/components/erp/format";

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const po = await getPurchaseOrder(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = po.status;
  const canUpdate = can(ctx, "purchase_order.update");
  const canApprove = can(ctx, "purchase_order.approve") && (po.createdById !== ctx.userId || ctx.isOwner);
  const canCancel = can(ctx, "purchase_order.cancel");
  const canReceive = can(ctx, "inventory.create") && can(ctx, "inventory.post");
  const editable = s === "DRAFT" && canUpdate;

  const [products, lookups, warehouses, vendors] = editable
    ? await Promise.all([
        can(ctx, "product.view") ? listProducts(ctx, { pageSize: "100", status: "ACTIVE" }) : null,
        can(ctx, "product.view") ? listCatalogLookups(ctx) : null,
        prisma.warehouse.findMany({ where: { organizationId: ctx.organizationId, companyId: po.companyId, isActive: true }, orderBy: { code: "asc" } }),
        prisma.vendor.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" }, take: 500 }),
      ])
    : [null, null, [], []];

  // Keep products/tax rates already on the lines selectable even if archived or inactive.
  const productOptions = new Map<string, ProductOption>(
    po.lines.map((l) => [l.product.id, { id: l.product.id, sku: l.product.sku, name: l.product.name, price: l.unitPrice.toString(), taxRateId: null }] as const),
  );
  for (const p of products?.items ?? []) productOptions.set(p.id, { id: p.id, sku: p.sku, name: p.name, price: p.purchasePrice.toString(), taxRateId: p.taxRateId });
  const usedTaxIds = new Set(po.lines.map((l) => l.taxRateId));
  const taxOptions = (lookups?.taxRates ?? [])
    .filter((t) => t.isActive || usedTaxIds.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, rate: t.rate.toString() }));

  const receivable: ReceivableLine[] = po.lines
    .map((l) => ({ l, outstanding: dec(l.quantity).sub(l.receivedQty) }))
    .filter(({ outstanding }) => outstanding.gt(0))
    .map(({ l, outstanding }) => ({
      id: l.id,
      description: l.description,
      sku: l.product.sku,
      uom: l.uom?.code ?? "",
      outstanding: outstanding.toString(),
      needsLot: l.product.trackingMode !== "NONE",
      hasExpiry: l.product.hasExpiry,
    }));
  const billable = po.lines.some((l) => dec(l.receivedQty).sub(l.returnedQty).sub(l.billedQty).gt(0));
  const a = (action: string) => `/purchase-orders/${id}/${action}`;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Purchasing", "Purchase orders", po.number]}
        title={po.number}
        subtitle={`${po.vendor.name} · ${po.company.code} · ${po.branch.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {s === "DRAFT" && canUpdate ? <ActionButton path={a("submit")} label="Submit" variant="default" /> : null}
            {s === "PENDING_APPROVAL" && canApprove ? (
              <>
                <ActionButton path={a("approve")} label="Approve" variant="default" prompt="Approval note (optional)" promptField="note" />
                <ActionButton path={a("return")} label="Return" prompt="What needs to change?" promptField="note" />
              </>
            ) : null}
            {s === "PARTIALLY_RECEIVED" && canUpdate ? (
              <ActionButton path={a("close")} label="Close" prompt="Reason for short-closing (optional)" promptField="reason" confirm="Close this order? The remaining quantity will not be received." />
            ) : null}
            {billable && can(ctx, "vendor_bill.create") ? (
              <Link href={`/purchasing/bills/new?purchaseOrderId=${id}`} className="text-sm text-primary hover:underline">Create bill</Link>
            ) : null}
            {(s === "DRAFT" || s === "PENDING_APPROVAL" || s === "APPROVED") && canCancel ? (
              <ActionButton path={a("cancel")} label="Cancel" variant="ghost" prompt="Reason for cancelling" promptField="reason" confirm="Cancel this purchase order?" />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Lines</CardTitle></CardHeader>
            <CardContent>
              {po.lines.length === 0 ? <p className="text-sm text-muted">No lines yet.</p> : <DocumentLines lines={po.lines} currency={po.currency} progressLabel="Received" />}
              <DocumentTotals doc={po} currency={po.currency} />
            </CardContent>
          </Card>

          {(s === "APPROVED" || s === "PARTIALLY_RECEIVED") && receivable.length > 0 ? (
            <Card>
              <CardHeader><CardTitle>Receive goods</CardTitle></CardHeader>
              <CardContent>
                {canReceive ? (
                  <ReceiveForm purchaseOrderId={id} lines={receivable} />
                ) : (
                  <p className="text-sm text-muted">You need inventory create and post permissions to receive goods.</p>
                )}
              </CardContent>
            </Card>
          ) : null}

          {editable ? (
            <Card>
              <CardHeader><CardTitle>Edit draft</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/purchase-orders/${id}`} method="PATCH" successMessage="Purchase order updated">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Warehouse">
                      <Select name="warehouseId" defaultValue={po.warehouseId}>
                        {warehouses.some((w) => w.id === po.warehouseId) ? null : <option value={po.warehouseId}>{po.warehouse.code} (inactive)</option>}
                        {warehouses.map((w) => <option key={w.id} value={w.id}>{po.company.code} · {w.code} ({w.name})</option>)}
                      </Select>
                    </Field>
                    <Field label="Vendor">
                      <Select name="vendorId" defaultValue={po.vendorId}>
                        {vendors.some((v) => v.id === po.vendorId) ? null : <option value={po.vendorId}>{po.vendor.name} (inactive)</option>}
                        {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}{v.code ? ` (${v.code})` : ""}</option>)}
                      </Select>
                    </Field>
                    <Field label="Expected date"><Input type="date" name="expectedDate" defaultValue={dateInput(po.expectedDate)} data-nullable /></Field>
                    <Field label="Supplier state" hint="GST state code. Empty = vendor's state.">
                      <Input name="supplierState" inputMode="numeric" pattern="[0-9]{2}" maxLength={2} defaultValue={po.supplierState ?? ""} data-nullable />
                    </Field>
                  </div>
                  <LinesEditor
                    products={[...productOptions.values()]}
                    taxRates={taxOptions}
                    initial={po.lines.map((l) => ({
                      productId: l.productId,
                      description: l.description,
                      quantity: l.quantity.toString(),
                      unitPrice: l.unitPrice.toString(),
                      discountPercent: l.discountPercent.toString(),
                      taxRateId: l.taxRateId ?? "none",
                    }))}
                  />
                  <Field label="Notes"><Textarea name="notes" rows={3} defaultValue={po.notes ?? ""} data-nullable /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : po.notes ? (
            <Card>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent><p className="whitespace-pre-line text-sm">{po.notes}</p></CardContent>
            </Card>
          ) : null}

          {s !== "DRAFT" && s !== "PENDING_APPROVAL" ? (
            <Card>
              <CardHeader><CardTitle>Billed / received / returned</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                      <tr className="border-b border-[var(--ic-border)]">
                        <th className="py-2 pr-2">Item</th>
                        <th className="py-2 pr-2 text-right">Ordered</th>
                        <th className="py-2 pr-2 text-right">Received</th>
                        <th className="py-2 pr-2 text-right">Returned</th>
                        <th className="py-2 pr-2 text-right">Billed</th>
                        <th className="py-2 text-right">To bill</th>
                      </tr>
                    </thead>
                    <tbody>
                      {po.lines.map((l) => (
                        <tr key={l.id} className="border-b border-[var(--ic-border)] last:border-0">
                          <td className="py-2 pr-2">{l.description}<span className="block text-2xs text-subtle">{l.product.sku}</span></td>
                          <td className="py-2 pr-2 text-right">{formatQty(l.quantity)} {l.uom?.code ?? ""}</td>
                          <td className="py-2 pr-2 text-right">{formatQty(l.receivedQty)}</td>
                          <td className="py-2 pr-2 text-right">{formatQty(l.returnedQty)}</td>
                          <td className="py-2 pr-2 text-right">{formatQty(l.billedQty)}</td>
                          <td className="py-2 text-right font-medium">{formatQty(dec(l.receivedQty).sub(l.returnedQty).sub(l.billedQty).toString())}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-subtle">Vendor</dt>
                  <dd><Link href={`/purchasing/vendors/${po.vendorId}`} className="text-primary hover:underline">{po.vendor.name}</Link></dd>
                </div>
                <div><dt className="text-subtle">Company / branch</dt><dd>{po.company.code} · {po.branch.name}</dd></div>
                <div><dt className="text-subtle">Warehouse</dt><dd>{po.warehouse.code} · {po.warehouse.name}</dd></div>
                <div><dt className="text-subtle">Ordered / expected</dt><dd>{formatDate(po.orderDate)} → {formatDate(po.expectedDate)}</dd></div>
                <div><dt className="text-subtle">Supplier state</dt><dd>{po.supplierState ?? "—"}</dd></div>
                <div><dt className="text-subtle">Created by</dt><dd>{po.createdBy.name ?? po.createdBy.email} · {formatDateTime(po.createdAt)}</dd></div>
                {po.approvalReason ? <div><dt className="text-subtle">Needs approval because</dt><dd>{po.approvalReason}</dd></div> : null}
                {po.approvalNote ? <div><dt className="text-subtle">Approver note</dt><dd className="whitespace-pre-line">{po.approvalNote}</dd></div> : null}
                {po.approvedBy || po.approvedAt ? (
                  <div><dt className="text-subtle">Approved</dt><dd>{po.approvedBy ? (po.approvedBy.name ?? po.approvedBy.email) : "Auto-approved"} · {formatDateTime(po.approvedAt)}</dd></div>
                ) : null}
                {po.cancelReason ? (
                  <div><dt className="text-subtle">{s === "CLOSED" ? "Close reason" : "Cancel reason"}</dt><dd className="whitespace-pre-line">{po.cancelReason}</dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Receipts & returns</CardTitle></CardHeader>
            <CardContent>
              {po.stockEntries.length === 0 ? <p className="text-sm text-muted">Nothing received yet.</p> : null}
              <ul className="space-y-1 text-sm">
                {po.stockEntries.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2">
                    <Link href={`/inventory/entries/${e.id}`} className="text-primary hover:underline">{e.number}</Link>
                    <span className="text-muted">{humanize(e.type)}</span>
                    <StatusBadge status={e.status} />
                    {e.postedAt ? <span className="text-2xs text-subtle">{formatDate(e.postedAt)}</span> : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {can(ctx, "vendor_bill.view") ? (
            <Card>
              <CardHeader><CardTitle>Bills</CardTitle></CardHeader>
              <CardContent>
                {po.bills.length === 0 ? <p className="text-sm text-muted">No bills yet.</p> : null}
                <ul className="space-y-1 text-sm">
                  {po.bills.map((b) => (
                    <li key={b.id} className="flex flex-wrap items-center gap-2">
                      <Link href={`/purchasing/bills/${b.id}`} className="text-primary hover:underline">{b.number}</Link>
                      <span className="text-muted">{b.vendorInvoiceNumber}</span>
                      <StatusBadge status={b.status} />
                      <span className="text-muted">{formatMoney(b.grandTotal, po.currency)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="purchase_order" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
