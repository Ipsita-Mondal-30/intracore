import Link from "next/link";
import { listJobs } from "@/features/portal/technician";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";
import { pagePortal, PortalHeader, Section } from "@/app/portal/_components/portal-page";
import { technicianLinks } from "./nav";


export default async function TechnicianPortal({ searchParams }: { searchParams: Promise<{ open?: string }> }) {
  const p = await pagePortal("TECHNICIAN");
  const { open } = await searchParams;
  const { visits, installations } = await listJobs(p, { open: open === "false" ? "false" : "true" });
  return (
    <div>
      <PortalHeader title="My jobs" organization={p.organizationName} links={technicianLinks} />
      <Section title="Service visits">
        <ul className="space-y-2 text-sm">
          {visits.map((v) => {
            const customer = v.ticket?.customer ?? v.asset?.customer;
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-3">
                <StatusBadge status={v.status} />
                <Link className="font-medium text-primary hover:underline" href={`/portal/technician/visits/${v.id}`}>{formatDateTime(v.scheduledStart)}</Link>
                <span>{v.serviceType ? humanize(v.serviceType) : "Visit"}</span>
                {customer ? <span className="text-muted">{customer.name}</span> : null}
                {v.asset ? <span className="text-xs text-subtle">{v.asset.tag} · {v.asset.location ?? ""}</span> : null}
              </li>
            );
          })}
          {visits.length === 0 ? <li className="text-muted">No visits.</li> : null}
        </ul>
      </Section>
      <Section title="Installations">
        <ul className="space-y-2 text-sm">
          {installations.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-3">
              <StatusBadge status={j.status} />
              <Link className="font-medium text-primary hover:underline" href={`/portal/technician/installations/${j.id}`}>{j.number}</Link>
              <span>{formatDateTime(j.scheduledStart)}</span>
              <span className="text-muted">{j.customer.name}</span>
              <span className="text-xs text-subtle">{j.checklist.filter((c) => c.done).length}/{j.checklist.length} checklist</span>
            </li>
          ))}
          {installations.length === 0 ? <li className="text-muted">No installation jobs.</li> : null}
        </ul>
      </Section>
    </div>
  );
}
