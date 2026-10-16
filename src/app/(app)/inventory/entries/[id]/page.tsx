import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getStockEntry } from "@/features/inventory/entries";
import { ReturnLinesInput } from "@/features/inventory/json-inputs";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatMoney, formatQty, humanize } from "@/components/erp/format";

const link = (href: string, text: string) => <Link key={href} href={href} className="text-primary hover:underline">{text}</Link>;

export default async function StockEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const entry = await getStockEntry(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });

  const canPost = can(ctx, "inventory.post");
  const returnable = entry.lines
    .map((l) => ({ line: l, left: Number(l.quantity.toString()) - l.returnLines.reduce((s, r) => s + Number(r.quantity.toString()), 0) }))
    .filter((r) => r.left > 0);
  const canReturn =
    entry.status === "POSTED" &&
    (entry.type === "DELIVERY" || entry.type === "GOODS_RECEIPT") &&
    returnable.length > 0 &&
    can(ctx, "inventory.create") &&
    canPost;
  const skuByLine = new Map(entry.lines.map((l) => [l.id, l.product.sku]));

  const details: [string, ReactNode][] = [
    ["Type", humanize(entry.type)],
    ["From warehouse", entry.sourceWarehouse ? `${entry.sourceWarehouse.code} · ${entry.sourceWarehouse.name}` : "—"],
    ["To warehouse", entry.targetWarehouse ? `${entry.targetWarehouse.code} · ${entry.targetWarehouse.name}` : "—"],
    ["Reference", entry.reference ?? "—"],
    ["Posted", formatDateTime(entry.postedAt)],
    ["Created by", entry.createdBy.name ?? entry.createdBy.email],
  ];
  if (entry.salesOrder) details.push(["Sales order", link(`/sales/orders/${entry.salesOrder.id}`, entry.salesOrder.number)]);
  if (entry.purchaseOrder) details.push(["Purchase order", link(`/purchasing/orders/${entry.purchaseOrder.id}`, entry.purchaseOrder.number)]);
  if (entry.customer) details.push(["Customer", link(`/crm/customers/${entry.customer.id}`, entry.customer.name)]);
  if (entry.vendor) details.push(["Vendor", link(`/purchasing/vendors/${entry.vendor.id}`, entry.vendor.name)]);
  if (entry.returnOf) details.push(["Return of", link(`/inventory/entries/${entry.returnOf.id}`, `${entry.returnOf.number} (${humanize(entry.returnOf.type)})`)]);
  if (entry.returns.length) {
    details.push(["Returns", <span key="r" className="flex flex-wrap gap-2">{entry.returns.map((r) => <span key={r.id}>{link(`/inventory/entries/${r.id}`, r.number)} <StatusBadge status={r.status} /></span>)}</span>]);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Inventory", "Stock entries", entry.number]}
        title={entry.number}
        subtitle={humanize(entry.type)}
        actions={
          <>
            <StatusBadge status={entry.status} />
            {entry.status === "DRAFT" && canPost ? (
              <ActionButton path={`/stock-entries/${id}/post`} label="Post" variant="default" confirm="Post this entry? Stock moves are written to the ledger." />
            ) : null}
            {entry.status !== "CANCELLED" && canPost ? (
              <ActionButton
                path={`/stock-entries/${id}/cancel`}
                label="Cancel"
                prompt="Cancellation reason"
                confirm={entry.status === "POSTED" ? "This entry is posted. Cancelling writes reversing stock moves and updates linked orders. Continue?" : "Cancel this draft?"}
                variant="ghost"
              />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {entry.status === "CANCELLED" ? (
                <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-danger">
                  Cancelled {formatDate(entry.cancelledAt)}{entry.cancelReason ? `: “${entry.cancelReason}”` : ""}
                </p>
              ) : null}
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                {details.map(([label, value]) => (
                  <div key={label}><dt className="text-subtle">{label}</dt><dd>{value}</dd></div>
                ))}
              </dl>
              {entry.notes ? <p className="whitespace-pre-line text-sm text-muted">{entry.notes}</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Lines</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                  <tr className="border-b border-[var(--ic-border)]">
                    <th className="py-2 pr-2">Product</th>
                    <th className="py-2 pr-2 text-right">Qty</th>
                    <th className="py-2 pr-2 text-right">Base qty</th>
                    <th className="py-2 pr-2">Lot / expiry</th>
                    <th className="py-2 pr-2 text-right">Unit cost</th>
                    <th className="py-2 text-right">Returned</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((l) => (
                    <tr key={l.id} className="border-b border-[var(--ic-border)] last:border-0">
                      <td className="py-2 pr-2">
                        <Link href={`/inventory/products/${l.product.id}`} className="font-medium text-primary hover:underline">{l.product.name}</Link>
                        <span className="block text-2xs text-subtle">{l.product.sku}</span>
                      </td>
                      <td className="py-2 pr-2 text-right">{formatQty(l.quantity)} {l.uom?.code ?? ""}</td>
                      <td className="py-2 pr-2 text-right">{formatQty(l.baseQuantity)}</td>
                      <td className="py-2 pr-2">
                        {l.lot?.lotNumber ?? l.lotNumber ?? "—"}
                        {l.lot?.expiryDate ?? l.expiryDate ? <span className="block text-2xs text-subtle">exp. {formatDate(l.lot?.expiryDate ?? l.expiryDate)}</span> : null}
                      </td>
                      <td className="py-2 pr-2 text-right">{l.unitCost ? formatMoney(l.unitCost) : "—"}</td>
                      <td className="py-2 text-right">{l.returnLines.length ? formatQty(l.returnLines.reduce((s, r) => s + Number(r.quantity.toString()), 0)) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Ledger moves</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              {entry.moves.length ? (
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr className="border-b border-[var(--ic-border)]">
                      <th className="py-2 pr-2">Product</th>
                      <th className="py-2 pr-2">Location</th>
                      <th className="py-2 pr-2 text-right">Qty</th>
                      <th className="py-2 pr-2 text-right">Unit cost</th>
                      <th className="py-2 pr-2 text-right">Value</th>
                      <th className="py-2">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.moves.map((m) => (
                      <tr key={m.id} className="border-b border-[var(--ic-border)] last:border-0">
                        <td className="py-2 pr-2">
                          {skuByLine.get(m.entryLineId) ?? "—"}
                          {m.isReversal ? <Badge tone="warning" className="ml-2">Reversal</Badge> : null}
                        </td>
                        <td className="py-2 pr-2">{m.location.code}</td>
                        <td className={`py-2 pr-2 text-right ${m.quantity.isNegative() ? "text-danger" : "text-success"}`}>
                          {m.quantity.isNegative() ? "" : "+"}{formatQty(m.quantity)}
                        </td>
                        <td className="py-2 pr-2 text-right">{formatMoney(m.unitCost)}</td>
                        <td className="py-2 pr-2 text-right">{formatMoney(m.value)}</td>
                        <td className="py-2 text-2xs text-subtle">{formatDateTime(m.movedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-muted">{entry.status === "DRAFT" ? "No moves yet. Posting the entry writes them." : "No moves."}</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {canReturn ? (
            <Card>
              <CardHeader><CardTitle>{entry.type === "DELIVERY" ? "Customer return" : "Return to vendor"}</CardTitle></CardHeader>
              <CardContent>
                <ApiForm
                  path={`/stock-entries/${id}/return`}
                  submitLabel={entry.type === "DELIVERY" ? "Record customer return" : "Return to vendor"}
                  successMessage="Return posted"
                  redirect="/inventory/entries/:id"
                >
                  <ReturnLinesInput
                    lines={returnable.map(({ line, left }) => ({
                      id: line.id,
                      label: `${line.product.sku} · ${line.product.name}`,
                      returnable: String(left),
                      uom: line.uom?.code ?? "",
                    }))}
                  />
                  <Field label="Reason"><Input name="reason" /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="stock_entry" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
