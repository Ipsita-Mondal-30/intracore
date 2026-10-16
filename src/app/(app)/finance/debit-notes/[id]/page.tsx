import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getDebitNote } from "@/features/finance/payables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail, DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatMoney } from "@/components/erp/format";

export default async function DebitNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "vendor_bill.view")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Debit notes"]} title="Debit note" />
        <p className="text-sm text-muted">You don&apos;t have permission to view debit notes.</p>
      </div>
    );
  }
  const note = await getDebitNote(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = note.status;
  const title = note.number ?? "Draft debit note";

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Debit notes", title]}
        title={title}
        subtitle={`${note.vendor.name} · against ${note.bill.number} (${note.bill.vendorInvoiceNumber})`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {s === "DRAFT" && can(ctx, "vendor_bill.post") ? (
              <ActionButton path={`/debit-notes/${id}/post`} label="Post" variant="default" confirm="Post this debit note? It is applied to the bill's outstanding balance." />
            ) : null}
            {(s === "DRAFT" || s === "POSTED") && can(ctx, "vendor_bill.cancel") ? (
              <ActionButton path={`/debit-notes/${id}/cancel`} label="Cancel" variant="ghost" prompt="Reason for cancelling" promptField="reason" confirm="Cancel this debit note?" />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Lines</CardTitle></CardHeader>
            <CardContent>
              {note.lines.length === 0 ? <p className="text-sm text-muted">No lines.</p> : <DocumentLines lines={note.lines} currency="INR" />}
              <DocumentTotals doc={note} currency="INR" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Reason</CardTitle></CardHeader>
            <CardContent><p className="whitespace-pre-line text-sm">{note.reason}</p></CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-subtle">Bill</dt>
                  <dd><Link href={`/purchasing/bills/${note.billId}`} className="text-primary hover:underline">{note.bill.number}</Link></dd>
                </div>
                <div>
                  <dt className="text-subtle">Vendor</dt>
                  <dd><Link href={`/purchasing/vendors/${note.vendorId}`} className="text-primary hover:underline">{note.vendor.name}</Link></dd>
                </div>
                <div><dt className="text-subtle">Note date</dt><dd>{formatDate(note.noteDate)}</dd></div>
                <div><dt className="text-subtle">Applied to bill</dt><dd>{formatMoney(note.appliedAmount)} of {formatMoney(note.grandTotal)}</dd></div>
                {note.journalEntryId ? (
                  <div><dt className="text-subtle">Journal</dt><dd><Link href={`/finance/journals/${note.journalEntryId}`} className="text-primary hover:underline">View journal</Link></dd></div>
                ) : null}
                {note.postedAt ? <div><dt className="text-subtle">Posted</dt><dd>{formatDateTime(note.postedAt)}</dd></div> : null}
                {note.cancelReason ? (
                  <div><dt className="text-subtle">Cancelled</dt><dd className="whitespace-pre-line">{formatDateTime(note.cancelledAt)} · {note.cancelReason}</dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="debit_note" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
