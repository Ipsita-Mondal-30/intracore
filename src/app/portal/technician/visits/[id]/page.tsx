import { getVisit } from "@/features/portal/technician";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime } from "@/components/erp/format";
import { orNotFound, pagePortal, PortalHeader, Section } from "@/app/portal/_components/portal-page";
import { PortalAction, PortalForm } from "@/app/portal/_components/portal-client";
import { technicianLinks } from "../../nav";

export default async function VisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await pagePortal("TECHNICIAN");
  const v = await orNotFound(getVisit(p, id));
  const customer = v.ticket?.customer ?? v.asset?.customer;
  return (
    <div>
      <PortalHeader title="Service visit" organization={p.organizationName} links={technicianLinks} />
      <Section title={`${formatDateTime(v.scheduledStart)} – ${formatDateTime(v.scheduledEnd)}`}>
        <div className="space-y-1 text-sm">
          <StatusBadge status={v.status} />
          {customer ? <p>Customer: {customer.name}{customer.phone ? ` · ${customer.phone}` : ""}</p> : null}
          {v.asset ? <p>Equipment: {v.asset.tag} · {v.asset.name}{v.asset.serialNumber ? ` · S/N ${v.asset.serialNumber}` : ""}{v.asset.location ? ` · ${v.asset.location}` : ""}</p> : null}
          {v.ticket ? <p>Ticket {v.ticket.number}: {v.ticket.subject}</p> : null}
          {v.ticket?.description ? <p className="whitespace-pre-wrap text-muted">{v.ticket.description}</p> : null}
          {v.notes ? <p className="whitespace-pre-wrap">Notes: {v.notes}</p> : null}
          {v.workDone ? <p>Work done: {v.workDone}</p> : null}
        </div>
      </Section>
      {v.status === "SCHEDULED" ? <PortalAction path={`/technician/visits/${v.id}/start`} label="Start visit" variant="default" /> : null}
      {v.status === "IN_PROGRESS" ? (
        <Section title="Complete visit">
          <PortalForm path={`/technician/visits/${v.id}/complete`} submitLabel="Complete" successMessage="Visit completed">
            <Field label="Visit notes"><Textarea name="notes" rows={3} required maxLength={5000} /></Field>
            <Field label="Work done (shown to the customer)"><Textarea name="workDone" rows={2} maxLength={5000} /></Field>
            <Field label="Signed by (customer)"><Input name="customerSignedBy" maxLength={200} /></Field>
          </PortalForm>
        </Section>
      ) : null}
    </div>
  );
}
