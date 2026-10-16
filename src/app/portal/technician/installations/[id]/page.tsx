import { getInstallation } from "@/features/portal/technician";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime } from "@/components/erp/format";
import { orNotFound, pagePortal, PortalHeader, Section } from "@/app/portal/_components/portal-page";
import { PortalAction, PortalForm } from "@/app/portal/_components/portal-client";
import { technicianLinks } from "../../nav";

export default async function InstallationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await pagePortal("TECHNICIAN");
  const j = await orNotFound(getInstallation(p, id));
  const working = j.status === "IN_PROGRESS" || j.status === "SCHEDULED";
  return (
    <div>
      <PortalHeader title={`Installation ${j.number}`} organization={p.organizationName} links={technicianLinks} />
      <Section title={`${formatDateTime(j.scheduledStart)} – ${formatDateTime(j.scheduledEnd)}`}>
        <div className="space-y-1 text-sm">
          <StatusBadge status={j.status} />
          <p>Customer: {j.customer.name}{j.customer.phone ? ` · ${j.customer.phone}` : ""}</p>
          <p>Site: {j.address ?? j.customer.shippingAddress ?? "—"}</p>
          {j.asset ? <p>Equipment: {j.asset.tag} · {j.asset.name}</p> : null}
          {j.notes ? <p className="whitespace-pre-wrap">Notes: {j.notes}</p> : null}
        </div>
      </Section>
      <Section title="Checklist">
        <ul className="space-y-2 text-sm">
          {j.checklist.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3">
              <span className={c.done ? "line-through text-muted" : ""}>{c.label}{c.required ? " *" : ""}</span>
              {working ? <PortalAction method="PATCH" path={`/technician/installations/${j.id}/checklist/${c.id}`} body={{ done: !c.done }} label={c.done ? "Undo" : "Done"} /> : null}
            </li>
          ))}
          {j.checklist.length === 0 ? <li className="text-muted">No checklist.</li> : null}
        </ul>
      </Section>
      {j.status === "SCHEDULED" ? <PortalAction path={`/technician/installations/${j.id}/start`} label="Start job" variant="default" /> : null}
      {j.status === "IN_PROGRESS" ? (
        <Section title="Complete job">
          <PortalForm path={`/technician/installations/${j.id}/complete`} submitLabel="Complete" successMessage="Job completed">
            <Textarea name="notes" rows={3} maxLength={5000} placeholder="Completion notes" />
          </PortalForm>
        </Section>
      ) : null}
    </div>
  );
}
