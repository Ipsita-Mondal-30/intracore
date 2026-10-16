import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getVisit } from "@/features/service/field";
import { userNames } from "@/features/service/lookups";
import { listDocuments } from "@/features/documents/service";
import { DocumentDownload, DocumentUpload } from "@/features/finance/document-upload";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDateTime, humanize } from "@/components/erp/format";

export default async function VisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "field.view")) return <p className="text-sm text-muted">You don&apos;t have permission to view field work.</p>;
  const v = await getVisit(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canSchedule = can(ctx, "field.schedule");
  const canWork = can(ctx, "field.update") && (v.technicianId === ctx.userId || canSchedule);
  const [names, documents] = await Promise.all([userNames([v.technicianId]), can(ctx, "document.view") ? listDocuments(ctx, "service_visit", id) : null]);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Service", "Field schedule", formatDateTime(v.scheduledStart)]}
        title={`${v.serviceType ? humanize(v.serviceType) : "Visit"} · ${names.get(v.technicianId) ?? "Technician"}`}
        subtitle={`${formatDateTime(v.scheduledStart)} – ${formatDateTime(v.scheduledEnd)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={v.status} />
            {canWork && v.status === "SCHEDULED" ? <ActionButton path={`/service-visits/${id}/start`} label="Check in" variant="default" /> : null}
            {canSchedule && v.status === "SCHEDULED" ? (
              <>
                <ActionButton path={`/service-visits/${id}/no-show`} label="No show" confirm="Mark as no show?" />
                <ActionButton path={`/service-visits/${id}/cancel`} label="Cancel" variant="ghost" prompt="Reason for cancelling" />
              </>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {canWork && v.status === "IN_PROGRESS" ? (
            <Card>
              <CardHeader><CardTitle>Complete visit</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/service-visits/${id}/complete`} submitLabel="Complete" successMessage="Visit completed" className="space-y-3">
                  <Field label="Visit notes"><Textarea name="notes" rows={3} required defaultValue={v.notes ?? ""} /></Field>
                  <Field label="Work done"><Textarea name="workDone" rows={3} /></Field>
                  <Field label="Customer signed by"><Input name="customerSignedBy" maxLength={200} /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="whitespace-pre-line">{v.notes || "—"}</p>
                {v.workDone ? <p className="whitespace-pre-line"><span className="text-subtle">Work done: </span>{v.workDone}</p> : null}
                {v.customerSignedBy ? <p><span className="text-subtle">Signed by: </span>{v.customerSignedBy}</p> : null}
              </CardContent>
            </Card>
          )}
          {documents ? (
            <Card>
              <CardHeader><CardTitle>Evidence</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {documents.length === 0 ? <p className="text-muted">No photos or files yet.</p> : (
                  <ul className="space-y-1">{documents.map((d) => <li key={d.id}><DocumentDownload id={d.id} label={d.fileName} /> <span className="text-2xs text-subtle">{formatDateTime(d.createdAt)}</span></li>)}</ul>
                )}
                {canWork && can(ctx, "document.create") && v.status !== "CANCELLED" ? <DocumentUpload entityType="service_visit" entityId={id} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                {v.asset ? <div><dt className="text-subtle">Asset</dt><dd><Link href={`/service/assets/${v.asset.id}`} className="text-primary hover:underline">{v.asset.tag}</Link> {v.asset.name}</dd></div> : null}
                {v.contract ? <div><dt className="text-subtle">Contract</dt><dd><Link href={`/service/contracts/${v.contract.id}`} className="text-primary hover:underline">{v.contract.number}</Link></dd></div> : null}
                {v.ticket ? <div><dt className="text-subtle">Ticket</dt><dd>{v.ticket.number} · {v.ticket.subject}</dd></div> : null}
                {v.checkInAt ? <div><dt className="text-subtle">Checked in</dt><dd>{formatDateTime(v.checkInAt)}</dd></div> : null}
                {v.completedAt ? <div><dt className="text-subtle">Completed</dt><dd>{formatDateTime(v.completedAt)}</dd></div> : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="service_visit" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
