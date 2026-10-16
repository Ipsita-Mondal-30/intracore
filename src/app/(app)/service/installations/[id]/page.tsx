import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getInstallationJob } from "@/features/service/installations";
import { memberOptions, userNames } from "@/features/service/lookups";
import { listDocuments } from "@/features/documents/service";
import { DocumentDownload, DocumentUpload } from "@/features/finance/document-upload";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDateTime } from "@/components/erp/format";

export default async function InstallationJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "field.view")) return <p className="text-sm text-muted">You don&apos;t have permission to view field work.</p>;
  const job = await getInstallationJob(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canSchedule = can(ctx, "field.schedule");
  const canWork = can(ctx, "field.update") && (job.technicianId === ctx.userId || canSchedule);
  const open = job.status !== "COMPLETED" && job.status !== "CANCELLED";
  const [names, members, documents] = await Promise.all([
    userNames([job.technicianId, ...job.checklist.map((c) => c.doneById)]),
    canSchedule && (job.status === "PLANNED" || job.status === "SCHEDULED") ? memberOptions(ctx) : [],
    can(ctx, "document.view") ? listDocuments(ctx, "installation_job", id) : null,
  ]);
  const missing = job.checklist.filter((c) => c.required && !c.done).length;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Service", "Installations", job.number]}
        title={`${job.number} · ${job.customer.name}`}
        subtitle={job.scheduledStart ? `${formatDateTime(job.scheduledStart)} – ${formatDateTime(job.scheduledEnd)} · ${names.get(job.technicianId ?? "") ?? "Unassigned"}` : "Not scheduled"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={job.status} />
            {canWork && job.status === "SCHEDULED" ? <ActionButton path={`/installation-jobs/${id}/start`} label="Start" variant="default" /> : null}
            {canWork && job.status === "IN_PROGRESS" ? (
              <ActionButton path={`/installation-jobs/${id}/complete`} label="Complete" variant="default" confirm={missing ? `${missing} required item(s) are still open. Try anyway?` : "Mark the installation complete?"} />
            ) : null}
            {canSchedule && open ? <ActionButton path={`/installation-jobs/${id}/cancel`} label="Cancel" variant="ghost" prompt="Reason for cancelling" /> : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Checklist</CardTitle></CardHeader>
            <CardContent className="text-sm">
              {job.checklist.length === 0 ? <p className="text-muted">No checklist items.</p> : (
                <ul className="space-y-2">
                  {job.checklist.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <span aria-hidden>{c.done ? "☑" : "☐"}</span>
                      <span className={c.done ? "text-muted line-through" : ""}>{c.label}</span>
                      {!c.required ? <span className="text-2xs text-subtle">optional</span> : null}
                      {c.done && c.doneAt ? <span className="text-2xs text-subtle">{names.get(c.doneById ?? "") ?? ""} · {formatDateTime(c.doneAt)}</span> : null}
                      {canWork && open ? <ActionButton path={`/installation-jobs/${id}/checklist/${c.id}`} method="PATCH" body={{ done: !c.done }} label={c.done ? "Undo" : "Done"} variant="ghost" /> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {members.length ? (
            <Card>
              <CardHeader><CardTitle>{job.status === "PLANNED" ? "Schedule" : "Reschedule"}</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/installation-jobs/${id}`} method="PATCH" submitLabel="Save schedule" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Technician"><Select name="technicianId" required defaultValue={job.technicianId ?? ""}>{members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></Field>
                  <Field label="Start"><Input type="datetime-local" name="scheduledStart" required /></Field>
                  <Field label="End"><Input type="datetime-local" name="scheduledEnd" required /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}
          {documents ? (
            <Card>
              <CardHeader><CardTitle>Photos and documents</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {documents.length === 0 ? <p className="text-muted">Nothing attached.</p> : (
                  <ul className="space-y-1">{documents.map((d) => <li key={d.id}><DocumentDownload id={d.id} label={d.fileName} /></li>)}</ul>
                )}
                {canWork && can(ctx, "document.create") ? <DocumentUpload entityType="installation_job" entityId={id} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Site</dt><dd>{job.address ?? "—"}</dd></div>
                {job.asset ? <div><dt className="text-subtle">Asset</dt><dd><Link href={`/service/assets/${job.asset.id}`} className="text-primary hover:underline">{job.asset.tag}</Link> {job.asset.name}</dd></div> : null}
                {job.notes ? <div><dt className="text-subtle">Notes</dt><dd className="whitespace-pre-line">{job.notes}</dd></div> : null}
                {job.completedAt ? <div><dt className="text-subtle">Completed</dt><dd>{formatDateTime(job.completedAt)}</dd></div> : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="installation_job" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
