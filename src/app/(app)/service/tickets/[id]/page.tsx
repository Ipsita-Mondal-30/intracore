import { notFound } from "next/navigation";
import { LeadPriority } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getTicket, RESOLUTION_CODES } from "@/features/service/tickets";
import { listDocuments } from "@/features/documents/service";
import { DocumentDownload, DocumentUpload } from "@/features/finance/document-upload";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDateTime, humanize } from "@/components/erp/format";
import { cn } from "@/lib/utils";

const ACTIVE = ["NEW", "OPEN", "IN_PROGRESS", "ON_HOLD"];

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "ticket.view")) notFound();
  const ticket = await getTicket(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = ticket.status;
  const canWork = can(ctx, "ticket.update");
  const canAssign = can(ctx, "ticket.assign") && ACTIVE.includes(s);
  const isActive = ACTIVE.includes(s);
  const [members, categories, documents] = await Promise.all([
    canAssign ? prisma.organizationMember.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { user: { select: { id: true, name: true, email: true } } } }) : [],
    canWork && isActive ? prisma.ticketCategory.findMany({ where: { organizationId: ctx.organizationId, isActive: true }, orderBy: { name: "asc" } }) : [],
    can(ctx, "document.view") ? listDocuments(ctx, "ticket", id) : null,
  ]);
  const name = (u: { name: string | null; email: string } | null) => (u ? u.name ?? u.email : "—");
  const due = (at: Date | null, done: Date | null) => {
    if (!at) return "—";
    const late = (done ?? new Date()) > at;
    return <>{formatDateTime(at)} {late ? <Badge tone="danger">{done ? "Missed" : "Overdue"}</Badge> : done ? <Badge tone="success">Met</Badge> : null}</>;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Service", "Tickets", ticket.number]}
        title={ticket.subject}
        subtitle={`${ticket.number} · ${humanize(ticket.priority)} priority · ${ticket.customer?.name ?? "no customer"}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {canWork && ["NEW", "OPEN", "ON_HOLD"].includes(s) ? <ActionButton path={`/tickets/${id}/start`} label={s === "ON_HOLD" ? "Resume" : "Start work"} variant="default" /> : null}
            {canWork && ["OPEN", "IN_PROGRESS"].includes(s) ? <ActionButton path={`/tickets/${id}/hold`} label="Hold" prompt="Reason for holding (optional)" /> : null}
            {canWork && s === "RESOLVED" ? <ActionButton path={`/tickets/${id}/close`} label="Close" confirm="Close this ticket?" /> : null}
            {canWork && (s === "RESOLVED" || s === "CLOSED") ? <ActionButton path={`/tickets/${id}/reopen`} label="Reopen" variant="ghost" prompt="Why reopen? (optional)" /> : null}
            {canWork && isActive ? <ActionButton path={`/tickets/${id}/cancel`} label="Cancel" variant="ghost" prompt="Reason for cancelling" /> : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {ticket.description ? (
            <Card><CardContent className="whitespace-pre-line pt-5 text-sm">{ticket.description}</CardContent></Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Conversation</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {ticket.messages.length === 0 ? <p className="text-sm text-muted">No messages yet.</p> : (
                <ul className="space-y-3 text-sm">
                  {ticket.messages.map((m) => (
                    <li key={m.id} className={cn("rounded-xl border px-3 py-2", m.visibility === "INTERNAL" ? "border-warning-border bg-warning-soft" : "border-[var(--ic-border)]")}>
                      <p className="mb-1 flex flex-wrap items-center gap-2 text-2xs text-subtle">
                        <span>{m.authorType === "SYSTEM" ? "System" : m.authorType === "CUSTOMER" ? "Customer" : name(m.author)}</span>
                        <span>{formatDateTime(m.createdAt)}</span>
                        <Badge tone={m.visibility === "INTERNAL" ? "warning" : "neutral"}>{m.visibility === "INTERNAL" ? "Internal note" : "Customer-visible"}</Badge>
                      </p>
                      <p className="whitespace-pre-line">{m.body}</p>
                    </li>
                  ))}
                </ul>
              )}
              {canWork && s !== "CANCELLED" ? (
                <ApiForm path={`/tickets/${id}/messages`} submitLabel="Add message" className="space-y-2 border-t border-[var(--ic-border)] pt-3">
                  <Textarea name="body" rows={3} required maxLength={20000} aria-label="Message" />
                  <div className="flex flex-wrap gap-2">
                    <Select name="visibility" defaultValue="INTERNAL" className="max-w-[220px]" aria-label="Visibility">
                      <option value="INTERNAL">Internal note</option>
                      <option value="PUBLIC">Reply to customer</option>
                    </Select>
                    <Select name="authorType" defaultValue="STAFF" className="max-w-[220px]" aria-label="Author">
                      <option value="STAFF">From us</option>
                      <option value="CUSTOMER">From the customer (log)</option>
                    </Select>
                  </div>
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          {canWork && isActive ? (
            <Card>
              <CardHeader><CardTitle>Resolve</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/tickets/${id}/resolve`} submitLabel="Mark resolved" successMessage="Ticket resolved" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Resolution code">
                    <Select name="resolutionCode" required>{RESOLUTION_CODES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select>
                  </Field>
                  <Field label="Notes" className="sm:col-span-2"><Input name="resolutionNotes" maxLength={10000} /></Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}

          {s === "RESOLVED" || s === "CLOSED" ? (
            <Card>
              <CardHeader><CardTitle>Resolution and feedback</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p><span className="text-subtle">Resolution:</span> {ticket.resolutionCode ? humanize(ticket.resolutionCode) : "—"} · {formatDateTime(ticket.resolvedAt)}</p>
                {ticket.resolutionNotes ? <p className="whitespace-pre-line">{ticket.resolutionNotes}</p> : null}
                {ticket.feedbackRating ? <p><span className="text-subtle">Customer rating:</span> {ticket.feedbackRating}/5{ticket.feedbackComment ? ` — “${ticket.feedbackComment}”` : ""}</p> : null}
                {canWork ? (
                  <ApiForm path={`/tickets/${id}/feedback`} submitLabel="Record feedback" className="grid gap-3 border-t border-[var(--ic-border)] pt-3 sm:grid-cols-3">
                    <Field label="Rating">
                      <Select name="rating" defaultValue={String(ticket.feedbackRating ?? 5)}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
                    </Field>
                    <Field label="Comment" className="sm:col-span-2"><Input name="comment" maxLength={2000} defaultValue={ticket.feedbackComment ?? ""} /></Field>
                  </ApiForm>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {documents ? (
            <Card>
              <CardHeader><CardTitle>Attachments</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {documents.length === 0 ? <p className="text-sm text-muted">No files attached.</p> : (
                  <ul className="space-y-1 text-sm">
                    {documents.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-baseline gap-2">
                        <DocumentDownload id={d.id} label={d.fileName} />
                        <span className="text-2xs text-subtle">{Math.ceil(d.sizeBytes / 1024)} KB · {formatDateTime(d.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {can(ctx, "document.create") && s !== "CANCELLED" ? <DocumentUpload entityType="ticket" entityId={id} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>SLA</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Policy</dt><dd>{ticket.slaPolicy?.name ?? "None"}</dd></div>
                <div><dt className="text-subtle">First response due</dt><dd>{due(ticket.firstResponseDueAt, ticket.firstRespondedAt)}</dd></div>
                {ticket.firstRespondedAt ? <div><dt className="text-subtle">First responded</dt><dd>{formatDateTime(ticket.firstRespondedAt)}</dd></div> : null}
                <div><dt className="text-subtle">Resolution due</dt><dd>{due(ticket.resolutionDueAt, ticket.resolvedAt)}</dd></div>
                {ticket.escalationLevel > 0 ? <div><dt className="text-subtle">Escalation</dt><dd>Level {ticket.escalationLevel} · {formatDateTime(ticket.escalatedAt)}</dd></div> : null}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Assignee</dt><dd>{ticket.assignee ? name(ticket.assignee) : "Unassigned"}</dd></div>
                <div><dt className="text-subtle">Customer</dt><dd>{ticket.customer?.name ?? "—"}{ticket.contact ? ` · ${ticket.contact.fullName}` : ""}</dd></div>
                <div><dt className="text-subtle">Asset</dt><dd>{ticket.asset ? `${ticket.asset.tag} · ${ticket.asset.name}` : "—"}</dd></div>
                <div><dt className="text-subtle">Category</dt><dd>{ticket.category?.name ?? "—"}</dd></div>
                <div><dt className="text-subtle">Source</dt><dd>{humanize(ticket.source)}</dd></div>
                <div><dt className="text-subtle">Company</dt><dd>{ticket.company.code}</dd></div>
                <div><dt className="text-subtle">Opened</dt><dd>{name(ticket.createdBy)} · {formatDateTime(ticket.createdAt)}</dd></div>
              </dl>
              {canAssign ? (
                <ApiForm path={`/tickets/${id}/assign`} submitLabel="Assign" className="flex flex-wrap items-end gap-2 border-t border-[var(--ic-border)] pt-3">
                  <Select name="assigneeId" defaultValue={ticket.assigneeId ?? ""} data-nullable aria-label="Technician" className="max-w-[220px]">
                    <option value="">Unassigned</option>
                    {members.map((m) => <option key={m.user.id} value={m.user.id}>{name(m.user)}</option>)}
                  </Select>
                </ApiForm>
              ) : null}
              {canWork && isActive ? (
                <details className="border-t border-[var(--ic-border)] pt-3 text-sm">
                  <summary className="cursor-pointer text-primary">Edit ticket</summary>
                  <ApiForm path={`/tickets/${id}`} method="PATCH" className="mt-3 space-y-3">
                    <Field label="Subject"><Input name="subject" defaultValue={ticket.subject} maxLength={300} /></Field>
                    <Field label="Priority" hint="Changing it recalculates SLA due dates">
                      <Select name="priority" defaultValue={ticket.priority}>{Object.values(LeadPriority).map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select>
                    </Field>
                    <Field label="Category">
                      <Select name="categoryId" defaultValue={ticket.categoryId ?? ""} data-nullable>
                        <option value="">None</option>
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </Select>
                    </Field>
                  </ApiForm>
                </details>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="ticket" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
