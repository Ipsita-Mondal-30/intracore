import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getDispatch } from "@/features/service/dispatch";
import { listDocuments } from "@/features/documents/service";
import { DocumentDownload, DocumentUpload } from "@/features/finance/document-upload";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDateTime } from "@/components/erp/format";

export default async function DispatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "field.view")) return <p className="text-sm text-muted">You don&apos;t have permission to view dispatches.</p>;
  const d = await getDispatch(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canUpdate = can(ctx, "field.update");
  const open = d.status === "DISPATCHED" || d.status === "IN_TRANSIT";
  const documents = can(ctx, "document.view") ? await listDocuments(ctx, "delivery_dispatch", id) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Service", "Dispatch & POD", d.stockEntry.number]}
        title={`Delivery ${d.stockEntry.number}`}
        subtitle={[d.stockEntry.customer?.name, d.carrier, d.trackingNumber].filter(Boolean).join(" · ")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} />
            {canUpdate && d.status === "DISPATCHED" ? <ActionButton path={`/dispatches/${id}/in-transit`} label="In transit" /> : null}
            {canUpdate && open ? <ActionButton path={`/dispatches/${id}/fail`} label="Delivery failed" variant="ghost" prompt="What went wrong?" /> : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {canUpdate && open ? (
            <Card>
              <CardHeader><CardTitle>Proof of delivery</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/dispatches/${id}/deliver`} submitLabel="Mark delivered" successMessage="Delivered" className="grid gap-3 sm:grid-cols-2">
                  <Field label="Received by"><Input name="receivedByName" required maxLength={200} /></Field>
                  <Field label="Received at" hint="Defaults to now"><Input type="datetime-local" name="deliveredAt" /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}
          {documents ? (
            <Card>
              <CardHeader><CardTitle>POD files</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {documents.length === 0 ? <p className="text-muted">No signed copy or photo attached.</p> : (
                  <ul className="space-y-1">{documents.map((doc) => <li key={doc.id}><DocumentDownload id={doc.id} label={doc.fileName} /></li>)}</ul>
                )}
                {can(ctx, "document.create") ? <DocumentUpload entityType="delivery_dispatch" entityId={id} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                {d.stockEntry.salesOrder ? <div><dt className="text-subtle">Sales order</dt><dd><Link href={`/sales/orders/${d.stockEntry.salesOrder.id}`} className="text-primary hover:underline">{d.stockEntry.salesOrder.number}</Link></dd></div> : null}
                <div><dt className="text-subtle">Vehicle / driver</dt><dd>{[d.vehicleNumber, d.driverName].filter(Boolean).join(" · ") || "—"}</dd></div>
                <div><dt className="text-subtle">Dispatched</dt><dd>{formatDateTime(d.dispatchedAt)}</dd></div>
                {d.deliveredAt ? <div><dt className="text-subtle">Delivered</dt><dd>{formatDateTime(d.deliveredAt)} · received by {d.receivedByName}</dd></div> : null}
                {d.failureReason ? <div><dt className="text-subtle">Failure</dt><dd>{d.failureReason}</dd></div> : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="delivery_dispatch" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
