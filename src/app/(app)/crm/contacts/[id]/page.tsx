import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getContact, getTimeline } from "@/features/customers/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDateTime, humanize } from "@/components/erp/format";

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const contact = await getContact(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const timeline = await getTimeline(ctx, { contactId: id });
  const canEdit = can(ctx, "contact.update");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["CRM", "Contacts", contact.fullName]}
        title={contact.fullName}
        subtitle={[contact.jobTitle, contact.customer?.name].filter(Boolean).join(" · ") || undefined}
        actions={
          <>
            <StatusBadge status={contact.status} />
            {contact.customer ? (
              <Link href={`/crm/customers/${contact.customer.id}`} className="text-sm text-primary hover:underline">View customer</Link>
            ) : null}
            {can(ctx, "contact.delete") && contact.status !== "ARCHIVED" ? (
              <ActionButton path={`/contacts/${id}`} method="PATCH" label="Archive" body={{ status: "ARCHIVED" }} confirm="Archive this contact?" variant="ghost" />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              {canEdit ? (
                <ApiForm path={`/contacts/${id}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="First name"><Input name="firstName" defaultValue={contact.firstName} required /></Field>
                  <Field label="Last name"><Input name="lastName" defaultValue={contact.lastName ?? ""} data-nullable /></Field>
                  <Field label="Job title"><Input name="jobTitle" defaultValue={contact.jobTitle ?? ""} data-nullable /></Field>
                  <Field label="Email"><Input name="email" type="email" defaultValue={contact.email ?? ""} data-nullable /></Field>
                  <Field label="Phone"><Input name="phone" defaultValue={contact.phone ?? ""} data-nullable /></Field>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <input type="checkbox" name="isPrimary" defaultChecked={contact.isPrimary} /> Primary contact
                  </label>
                  <Field label="Notes" className="sm:col-span-3"><Textarea name="notes" rows={3} defaultValue={contact.notes ?? ""} data-nullable /></Field>
                </ApiForm>
              ) : (
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-subtle">Email</dt><dd>{contact.email ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Phone</dt><dd>{contact.phone ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Job title</dt><dd>{contact.jobTitle ?? "—"}</dd></div>
                  <div><dt className="text-subtle">Notes</dt><dd className="whitespace-pre-line">{contact.notes ?? "—"}</dd></div>
                </dl>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
            <CardContent>
              {timeline.length === 0 ? <p className="text-sm text-muted">No interactions yet.</p> : null}
              <ol className="space-y-3">
                {timeline.map((e) => (
                  <li key={`${e.source}-${e.id}`} className="text-sm">
                    <p className="text-2xs text-subtle">{formatDateTime(e.occurredAt)} · {humanize(e.type)}</p>
                    <p className="font-medium">{e.subject}</p>
                    {e.body ? <p className="whitespace-pre-line text-muted">{e.body}</p> : null}
                    {e.actor ? <p className="text-2xs text-subtle">by {e.actor.name}</p> : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {can(ctx, "activity.create") ? (
            <Card>
              <CardHeader><CardTitle>Log interaction</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path="/activities" extra={{ contactId: id }} submitLabel="Log" successMessage="Logged">
                  <Field label="Type">
                    <Select name="type" defaultValue="CALL">
                      {["CALL", "EMAIL", "MEETING", "NOTE"].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                    </Select>
                  </Field>
                  <Field label="Subject"><Input name="subject" required /></Field>
                  <Field label="Details"><Textarea name="body" rows={3} /></Field>
                  <Field label="When"><Input type="datetime-local" name="occurredAt" /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="contact" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
