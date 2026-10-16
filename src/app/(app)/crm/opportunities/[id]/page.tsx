import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { getTimeline, listContacts } from "@/features/customers/service";
import { OPEN_STAGES, getOpportunity, isClosed } from "@/features/opportunities/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { dateInput, formatDate, formatDateTime, formatMoney, humanize } from "@/components/erp/format";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const opp = await getOpportunity(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const closed = isClosed(opp.stage);
  const canEdit = can(ctx, "opportunity.update") && !closed;
  const [timeline, quotations, contacts] = await Promise.all([
    getTimeline(ctx, { opportunityId: id }),
    can(ctx, "quotation.view")
      ? prisma.quotation.findMany({
          where: { AND: [companyScopeWhere(ctx), { opportunityId: id, status: { not: "SUPERSEDED" } }] },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : [],
    canEdit && can(ctx, "contact.view") ? listContacts(ctx, { customerId: opp.customerId, pageSize: "100" }) : null,
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["CRM", "Opportunities", opp.name]}
        title={opp.name}
        subtitle={`${formatMoney(opp.amount, opp.currency)} · ${opp.probability}% probability · close ${formatDate(opp.expectedCloseDate)}`}
        actions={<StatusBadge status={opp.stage} />}
      />

      {canEdit ? (
        <Card>
          <CardHeader><CardTitle>Stage</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {OPEN_STAGES.filter((s) => s !== opp.stage).map((s) => (
              <ActionButton key={s} path={`/opportunities/${id}/stage`} label={`Move to ${humanize(s)}`} body={{ stage: s }} />
            ))}
            <ActionButton path={`/opportunities/${id}/stage`} label="Mark won" body={{ stage: "WON" }} confirm="Mark this deal as won? Won deals cannot be reopened." variant="default" />
            <ActionButton path={`/opportunities/${id}/stage`} label="Mark lost" body={{ stage: "LOST" }} prompt="Loss reason" promptField="lossReason" variant="danger" />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              {canEdit ? (
                <ApiForm path={`/opportunities/${id}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Name"><Input name="name" defaultValue={opp.name} required /></Field>
                  <Field label="Amount"><Input name="amount" inputMode="decimal" defaultValue={opp.amount.toString()} /></Field>
                  <Field label="Probability %"><Input type="number" name="probability" min={0} max={100} defaultValue={opp.probability} /></Field>
                  <Field label="Expected close"><Input type="date" name="expectedCloseDate" defaultValue={dateInput(opp.expectedCloseDate)} data-nullable /></Field>
                  {contacts ? (
                    <Field label="Contact">
                      <Select name="contactId" defaultValue={opp.contactId ?? ""} data-nullable>
                        <option value="">No contact</option>
                        {contacts.items.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
                      </Select>
                    </Field>
                  ) : null}
                  <Field label="Description" className="sm:col-span-3"><Textarea name="description" rows={3} defaultValue={opp.description ?? ""} data-nullable /></Field>
                </ApiForm>
              ) : (
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-subtle">Amount</dt><dd>{formatMoney(opp.amount, opp.currency)}</dd></div>
                  <div><dt className="text-subtle">Expected close</dt><dd>{formatDate(opp.expectedCloseDate)}</dd></div>
                  {opp.closedAt ? <div><dt className="text-subtle">Closed</dt><dd>{formatDate(opp.closedAt)}</dd></div> : null}
                  {opp.lossReason ? <div><dt className="text-subtle">Loss reason</dt><dd>{opp.lossReason}</dd></div> : null}
                  <div className="sm:col-span-2"><dt className="text-subtle">Description</dt><dd className="whitespace-pre-line">{opp.description ?? "—"}</dd></div>
                </dl>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Linked records</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-subtle">Customer</dt><dd><Link href={`/crm/customers/${opp.customer.id}`} className="text-primary hover:underline">{opp.customer.name}</Link></dd></div>
                <div><dt className="text-subtle">Contact</dt><dd>{opp.contact ? <Link href={`/crm/contacts/${opp.contact.id}`} className="text-primary hover:underline">{opp.contact.fullName}</Link> : "—"}</dd></div>
                <div><dt className="text-subtle">Source lead</dt><dd>{opp.lead ? <Link href={`/leads/${opp.lead.id}`} className="text-primary hover:underline">{opp.lead.fullName}</Link> : "—"}</dd></div>
                <div><dt className="text-subtle">Owner</dt><dd>{opp.owner?.name ?? opp.owner?.email ?? "—"}</dd></div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Quotations</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {quotations.length === 0 ? <p className="text-sm text-muted">No quotations yet.</p> : null}
              <ul className="space-y-1 text-sm">
                {quotations.map((q) => (
                  <li key={q.id} className="flex items-center gap-2">
                    <Link href={`/sales/quotations/${q.id}`} className="text-primary hover:underline">{q.number}{q.revision > 1 ? ` R${q.revision}` : ""}</Link>
                    <StatusBadge status={q.status} /> <span className="text-muted">{formatMoney(q.grandTotal, q.currency)}</span>
                  </li>
                ))}
              </ul>
              {can(ctx, "quotation.create") && !closed ? (
                <Link href={`/sales/quotations/new?customerId=${opp.customerId}&opportunityId=${id}`} className="text-sm text-primary hover:underline">New quotation</Link>
              ) : null}
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
                <ApiForm path="/activities" extra={{ opportunityId: id }} submitLabel="Log" successMessage="Logged">
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
            <CardContent><AuditTrail ctx={ctx} entity="opportunity" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
