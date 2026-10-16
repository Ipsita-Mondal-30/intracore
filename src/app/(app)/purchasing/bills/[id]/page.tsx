import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getVendorBill } from "@/features/purchasing/bills";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail, DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { formatDate, formatDateTime } from "@/components/erp/format";

export default async function VendorBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const bill = await getVendorBill(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = bill.status;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Purchasing", "Vendor bills", bill.number]}
        title={bill.number}
        subtitle={`${bill.vendor.name} · invoice ${bill.vendorInvoiceNumber} · ${bill.company.code} · ${bill.branch.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
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
                {bill.postedAt ? <div><dt className="text-subtle">Posted</dt><dd>{formatDateTime(bill.postedAt)}</dd></div> : null}
                {bill.cancelReason ? (
                  <div><dt className="text-subtle">Cancelled</dt><dd className="whitespace-pre-line">{formatDateTime(bill.cancelledAt)} · {bill.cancelReason}</dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="vendor_bill" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
