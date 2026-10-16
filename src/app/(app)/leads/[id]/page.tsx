import { notFound } from "next/navigation";
import { format } from "date-fns";
import { hasPermission, requirePermission } from "@/lib/tenant";
import { getLeadDetail, getLeadLookups } from "@/features/leads/queries";
import { LeadOverviewView } from "@/features/leads/lead-overview-view";

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await requirePermission("lead.view");
  const { id } = await params;
  const rawSearch = await searchParams;
  const openDialOnMount = rawSearch.dial === "1" || rawSearch.dial === "true";
  const [lead, lookups] = await Promise.all([
    getLeadDetail(tenant, id),
    getLeadLookups(tenant.organizationId),
  ]);
  if (!lead) notFound();

  return (
    <LeadOverviewView
      lead={JSON.parse(JSON.stringify(lead))}
      stages={lookups.stages.map((s) => ({ id: s.id, name: s.name }))}
      customFields={lookups.customFields.map((f) => ({
        id: f.id,
        key: f.key,
        label: f.label,
        type: f.type,
        section: f.section,
        options: f.options,
      }))}
      lastUpdated={format(new Date(), "h.mm a dd MMM yyyy")}
      canEdit={hasPermission(tenant, "lead.edit")}
      canConvert={hasPermission(tenant, "lead.convert")}
      openDialOnMount={openDialOnMount}
    />
  );
}
