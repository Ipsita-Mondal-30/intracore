import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { dec } from "@/lib/money";
import { can, getAccessContext } from "@/lib/access";
import { getVendorBill } from "@/features/purchasing/bills";
import { billOutstanding } from "@/features/finance/payables";
import { DebitNoteForm } from "@/features/finance/debit-note-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail, DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { dateInput, formatDate, formatDateTime, formatMoney } from "@/components/erp/format";

export default async function VendorBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const bill = await getVendorBill(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = bill.status;
  const outstanding = billOutstanding(bill);
  const canDebit = s === "POSTED" && can(ctx, "vendor_bill.create");
  const [allocations, debitNotes, approver, debited] = await Promise.all([
    prisma.payableAllocation.findMany({
      where: { organizationId: ctx.organizationId, billId: id },
      include: { payment: { select: { id: true, number: true } }, debitNote: { select: { id: true, number: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.debitNote.findMany({ where: { organizationId: ctx.organizationId, billId: id }, orderBy: { createdAt: "desc" } }),
    bill.approvedById ? prisma.user.findUnique({ where: { id: bill.approvedById }, select: { name: true, email: true } }) : null,
    canDebit
      ? prisma.debitNoteLine.groupBy({ by: ["billLineId"], where: { billLineId: { in: bill.lines.map((l) => l.id) }, debitNote: { status: "POSTED" } }, _sum: { quantity: true } })
      : [],
  ]);
  const debitable = bill.lines
    .map((l) => ({ l, remaining: dec(l.quantity).sub(dec(debited.find((d) => d.billLineId === l.id)?._sum.quantity ?? 0)) }))
    .filter(({ remaining }) => remaining.gt(0))
    .map(({ l, remaining }) => ({ id: l.id, description: l.description, sku: l.product?.sku ?? "", uom: "", remaining: remaining.toString(), unitPrice: l.unitPrice.toString() }));

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Purchasing", "Vendor bills", bill.number]}
        title={bill.number}
        subtitle={`${bill.vendor.name} · invoice ${bill.vendorInvoiceNumber} · ${bill.company.code} · ${bill.branch.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {s === "DRAFT" && !bill.approvedAt && can(ctx, "vendor_bill.approve") && (bill.createdById !== ctx.userId || ctx.isOwner) ? (
              <ActionButton path={`/vendor-bills/${id}/approve`} label="Approve" confirm="Approve this bill for posting?" />
            ) : null}
            {s === "POSTED" && outstanding.gt(0) && can(ctx, "payment.create") ? (
              <Link href={`/finance/payments/new?billId=${id}`} className="text-sm text-primary hover:underline">Record payment</Link>
            ) : null}
            {s === "DRAFT" && can(ctx, "vendor_bill.post") ? (
              <ActionButton path={`/vendor-bills/${id}/post`} label="Post" variant="default" confirm="Post this bill? Quantities are checked against goods received." />
            ) : null}
            {(s === "DRAFT" || s === "POSTED") && can(ctx, "vendor_bill.cancel") ? (
              <ActionButton path={`/vendor-bills/${id}/cancel`} label="Cancel" variant="ghost" prompt="Reason for cancelling" promptField="reason" confirm="Cancel this bill?" />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Lines</CardTitle></CardHeader>
            <CardContent>
              {bill.lines.length === 0 ? <p className="text-sm text-muted">No lines.</p> : <DocumentLines lines={bill.lines} currency={bill.currency} />}
              <DocumentTotals doc={bill} currency={bill.currency} />
            </CardContent>
          </Card>
          {allocations.length > 0 || debitNotes.length > 0 ? (
            <Card>
              <CardHeader><CardTitle>Payments &amp; debit notes</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {allocations.length > 0 ? (
                  <table className="w-full text-sm">
                    <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                      <tr className="border-b border-[var(--ic-border)]">
                        <th className="py-2 pr-2">Settled by</th>
                        <th className="py-2 pr-2">On</th>
                        <th className="py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allocations.map((a) => (
                        <tr key={a.id} className={`border-b border-[var(--ic-border)] last:border-0 ${a.reversedAt ? "text-subtle line-through" : ""}`}>
                          <td className="py-2 pr-2">
                            {a.payment ? (
                              <Link href={`/finance/payments/${a.payment.id}`} className="text-primary hover:underline">Payment {a.payment.number}</Link>
                            ) : a.debitNote ? (
                              <Link href={`/finance/debit-notes/${a.debitNote.id}`} className="text-primary hover:underline">Debit note {a.debitNote.number}</Link>
                            ) : "—"}
                          </td>
                          <td className="py-2 pr-2">{formatDateTime(a.createdAt)}</td>
                          <td className="py-2 text-right">{formatMoney(a.amount, bill.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {debitNotes.length > 0 ? (
                  <ul className="space-y-1 text-sm">
                    {debitNotes.map((n) => (
                      <li key={n.id} className="flex flex-wrap items-center gap-2">
                        <Link href={`/finance/debit-notes/${n.id}`} className="text-primary hover:underline">{n.number ?? "Draft debit note"}</Link>
                        <span className="text-muted">{formatDate(n.noteDate)} · {formatMoney(n.grandTotal, bill.currency)}</span>
                        <StatusBadge status={n.status} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          {canDebit && debitable.length > 0 ? (
            <Card>
              <CardHeader><CardTitle>Raise debit note</CardTitle></CardHeader>
              <CardContent><DebitNoteForm billId={id} lines={debitable} today={dateInput(new Date())} /></CardContent>
            </Card>
          ) : null}
          {bill.notes ? (
            <Card>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent><p className="whitespace-pre-line text-sm">{bill.notes}</p></CardContent>
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
                  <dd><Link href={`/purchasing/vendors/${bill.vendorId}`} className="text-primary hover:underline">{bill.vendor.name}</Link></dd>
                </div>
                <div><dt className="text-subtle">Vendor invoice no.</dt><dd>{bill.vendorInvoiceNumber}</dd></div>
                <div>
                  <dt className="text-subtle">Purchase order</dt>
                  <dd>
                    {bill.purchaseOrder ? (
                      <Link href={`/purchasing/orders/${bill.purchaseOrder.id}`} className="text-primary hover:underline">{bill.purchaseOrder.number}</Link>
                    ) : "—"}
                  </dd>
                </div>
                <div><dt className="text-subtle">Company / branch</dt><dd>{bill.company.code} · {bill.branch.name}</dd></div>
                <div><dt className="text-subtle">Bill date / due</dt><dd>{formatDate(bill.billDate)} → {formatDate(bill.dueDate)}</dd></div>
                <div><dt className="text-subtle">Supplier state</dt><dd>{bill.supplierState ?? "—"}</dd></div>
                <div><dt className="text-subtle">Created by</dt><dd>{bill.createdBy.name ?? bill.createdBy.email} · {formatDateTime(bill.createdAt)}</dd></div>
                {bill.approvedAt ? (
                  <div><dt className="text-subtle">Approved</dt><dd>by {approver?.name ?? approver?.email ?? "—"} on {formatDateTime(bill.approvedAt)}</dd></div>
                ) : null}
                {bill.postedAt ? <div><dt className="text-subtle">Posted</dt><dd>{formatDateTime(bill.postedAt)}</dd></div> : null}
                {bill.journalEntryId ? (
                  <div><dt className="text-subtle">Journal</dt><dd><Link href={`/finance/journals/${bill.journalEntryId}`} className="text-primary hover:underline">View journal</Link></dd></div>
                ) : null}
                {bill.cancelReason ? (
                  <div><dt className="text-subtle">Cancelled</dt><dd className="whitespace-pre-line">{formatDateTime(bill.cancelledAt)} · {bill.cancelReason}</dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          {s === "POSTED" ? (
            <Card>
              <CardHeader><CardTitle>Settlement</CardTitle></CardHeader>
              <CardContent>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between text-muted"><dt>Grand total</dt><dd>{formatMoney(bill.grandTotal, bill.currency)}</dd></div>
                  <div className="flex justify-between text-muted"><dt>Paid</dt><dd>{formatMoney(bill.paidAmount, bill.currency)}</dd></div>
                  <div className="flex justify-between text-muted"><dt>Debited</dt><dd>{formatMoney(bill.debitedAmount, bill.currency)}</dd></div>
                  <div className="flex justify-between border-t border-[var(--ic-border)] pt-2 font-semibold"><dt>Outstanding</dt><dd>{formatMoney(outstanding.toString(), bill.currency)}</dd></div>
                </dl>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="vendor_bill" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
