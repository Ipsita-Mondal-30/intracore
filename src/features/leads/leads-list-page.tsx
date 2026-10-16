import { redirect } from "next/navigation";
import type { LeadStatus } from "@prisma/client";
import { hasPermission, requirePermission } from "@/lib/tenant";
import {
  getCachedLeadDashboardStats,
  getLeadListStats,
  getLeadLookups,
  getLeadViewBySlug,
  listLeads,
  listLeadsForKanban,
} from "@/features/leads/queries";
import { LeadsWorkspace } from "@/features/leads/leads-workspace";
import { perfTime } from "@/lib/perf";
import { parseViewFilterConfig, CRM_LIST_COLUMNS, REENGAGED_LIST_COLUMNS, type ListColumnKey } from "@/lib/leads/view-filters";

export type LeadListPreset = {
  status?: LeadStatus;
  interested?: boolean;
};

function stringParams(raw: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

function mergePresetParams(
  raw: Record<string, string | string[] | undefined>,
  preset?: LeadListPreset,
) {
  const merged = { ...raw };
  if (preset?.status) merged.status = preset.status;
  if (preset?.interested) merged.interested = "true";
  return merged;
}

export async function LeadsListPage({
  searchParams,
  preset,
  viewSlug,
  title,
  breadcrumbs,
  listTitle,
  basePath,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  preset?: LeadListPreset;
  viewSlug?: string;
  title?: string;
  breadcrumbs?: string[];
  listTitle?: string;
  basePath?: string;
}) {
  const tenant = await requirePermission("lead.view");
  const rawParams = await searchParams;
  const params = mergePresetParams(
    viewSlug ? { ...rawParams, slug: viewSlug } : rawParams,
    preset,
  );

  const leadView = viewSlug
    ? await getLeadViewBySlug(tenant.organizationId, viewSlug)
    : null;

  if (viewSlug && !leadView) {
    redirect("/leads");
  }

  if (leadView?.href) {
    const filterConfig = parseViewFilterConfig(leadView.filters);
    if (Object.keys(filterConfig).length === 0) {
      redirect(leadView.href);
    }
  }

  const view = typeof params.view === "string" ? params.view : "table";
  const canCreate = hasPermission(tenant, "lead.create");
  const canExport = hasPermission(tenant, "lead.export");
  const canImport = hasPermission(tenant, "lead.import");
  const resolvedBasePath = basePath ?? (viewSlug ? `/leads/view/${viewSlug}` : "/leads");
  const resolvedTitle = title ?? leadView?.name ?? "Leads";
  const resolvedListTitle = listTitle ?? leadView?.name ?? "All leads";
  const resolvedBreadcrumbs = breadcrumbs ?? ["Leads", leadView?.name ?? "All"];

  const queryTimer = perfTime(`leads.list+lookups:${resolvedBasePath}`);
  // Lookups first (cached), then list/stats — avoids exhausting Vercel's
  // Prisma pool (connection_limit=1) with too many concurrent queries.
  const lookups = await getLeadLookups(tenant.organizationId);
  const [list, kanban, stats, org] = await Promise.all([
    view === "kanban" ? null : listLeads(tenant, params),
    view === "kanban" ? listLeadsForKanban(tenant, params) : null,
    viewSlug || preset
      ? getLeadListStats(tenant, params)
      : getCachedLeadDashboardStats(tenant.organizationId, tenant.userId),
    import("@/lib/db/prisma").then(({ prisma }) =>
      prisma.organization.findUnique({
        where: { id: tenant.organizationId },
        select: { timezone: true },
      }),
    ),
  ]);
  queryTimer.end();

  if (list?.redirectHref) {
    redirect(list.redirectHref);
  }

  const timezone = org?.timezone ?? "UTC";

  const columns =
    viewSlug === "new-leads"
      ? [...CRM_LIST_COLUMNS]
      : viewSlug === "re-engaged"
        ? [...REENGAGED_LIST_COLUMNS]
        : ((leadView?.columns as ListColumnKey[] | null) ?? undefined);
  const viewFilters = leadView
    ? parseViewFilterConfig(leadView.filters)
    : undefined;

  const rows = (list?.rows ?? kanban?.rows ?? []).map((lead) => ({
    id: lead.id,
    fullName: lead.fullName,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    status: lead.status,
    priority: lead.priority,
    leadScore: lead.leadScore,
    nextFollowUpAt: lead.nextFollowUpAt,
    callbackAt: lead.callbackAt,
    reEngagedAt: lead.reEngagedAt,
    createdAt: lead.createdAt,
    source: lead.source,
    stage: lead.stage,
    assignedUser: lead.assignedUser,
    flags: lead.flags?.map((f) => f.flag) ?? [],
  }));

  const listParams = stringParams(params);

  return (
    <LeadsWorkspace
      rows={rows}
      total={list?.total ?? rows.length}
      page={list?.page ?? 1}
      pageSize={list?.pageSize ?? rows.length}
      params={listParams}
      lookups={lookups}
      stats={{
        total: stats.total,
        newLeads: stats.newLeads,
        converted: stats.converted,
        followUpsDue: stats.followUpsDue,
      }}
      canCreate={canCreate}
      canExport={canExport}
      canImport={canImport}
      canEdit={hasPermission(tenant, "lead.edit")}
      canAssign={hasPermission(tenant, "lead.assign")}
      canTransfer={hasPermission(tenant, "lead.transfer")}
      canStage={hasPermission(tenant, "lead.change_stage")}
      canDelete={hasPermission(tenant, "lead.delete")}
      canChat={hasPermission(tenant, "chat.view")}
      title={resolvedTitle}
      breadcrumbs={resolvedBreadcrumbs}
      listTitle={resolvedListTitle}
      basePath={resolvedBasePath}
      lockedStatus={preset?.status ?? (viewFilters?.status as string | undefined)}
      lockedInterested={preset?.interested ?? viewFilters?.interested}
      columns={columns}
      timezone={timezone}
      crmLayout={Boolean(viewSlug)}
    />
  );
}
