import { cache } from "react";
import { prisma } from "@/lib/db/prisma";
import {
  seedOrganizationLeadDefaults,
  ensureMissingSystemLeadViews,
} from "@/lib/leads/seed-defaults";
import { orgCache } from "@/lib/cache/request-cache";
import type { Prisma } from "@prisma/client";
import { leadListQuerySchema } from "@/lib/validations/leads";
import type { TenantContext } from "@/lib/tenant";
import { leadVisibilityWhere } from "@/features/leads/scope";
import {
  parseViewFilterConfig,
  resolveViewFilters,
} from "@/lib/leads/view-filters";

export function parseLeadListQuery(
  raw: Record<string, string | string[] | undefined>,
) {
  return leadListQuerySchema.parse({
    q: typeof raw.q === "string" ? raw.q : undefined,
    status: typeof raw.status === "string" && raw.status ? raw.status : undefined,
    stageId: typeof raw.stageId === "string" && raw.stageId ? raw.stageId : undefined,
    sourceId:
      typeof raw.sourceId === "string" && raw.sourceId ? raw.sourceId : undefined,
    priority:
      typeof raw.priority === "string" && raw.priority ? raw.priority : undefined,
    assignedUserId:
      typeof raw.assignedUserId === "string" && raw.assignedUserId
        ? raw.assignedUserId
        : undefined,
    from: typeof raw.from === "string" ? raw.from : undefined,
    to: typeof raw.to === "string" ? raw.to : undefined,
    view: typeof raw.view === "string" ? raw.view : undefined,
    interested:
      typeof raw.interested === "string" && raw.interested === "true"
        ? "true"
        : undefined,
    page: raw.page,
    pageSize: raw.pageSize,
    sort: raw.sort,
    dir: raw.dir,
  });
}

export function leadListWhere(
  tenant: TenantContext,
  parsed: ReturnType<typeof parseLeadListQuery>,
  viewFilters?: Prisma.LeadWhereInput,
): Prisma.LeadWhereInput {
  const where: Prisma.LeadWhereInput = {
    ...leadVisibilityWhere(tenant),
    archivedAt: null,
    ...(viewFilters ?? {}),
  };

  if (parsed.status) where.status = parsed.status;
  if (parsed.stageId) where.stageId = parsed.stageId;
  if (parsed.sourceId) where.sourceId = parsed.sourceId;
  if (parsed.priority) where.priority = parsed.priority;
  if (parsed.assignedUserId) where.assignedUserId = parsed.assignedUserId;
  if (parsed.interested === "true") where.productId = { not: null };
  if (parsed.from || parsed.to) {
    where.createdAt = {
      ...(parsed.from ? { gte: new Date(parsed.from) } : {}),
      ...(parsed.to ? { lte: new Date(`${parsed.to}T23:59:59`) } : {}),
    };
  }
  if (parsed.q) {
    where.OR = [
      { fullName: { contains: parsed.q, mode: "insensitive" } },
      { company: { contains: parsed.q, mode: "insensitive" } },
      { email: { contains: parsed.q, mode: "insensitive" } },
      { phone: { contains: parsed.q, mode: "insensitive" } },
    ];
  }
  return where;
}

const leadListIncludeMinimal = {
  source: true,
  stage: true,
  assignedUser: { select: { id: true, name: true, email: true } },
  followUps: {
    where: { status: "PENDING" as const },
    orderBy: { dueAt: "asc" as const },
    take: 1,
  },
} satisfies Prisma.LeadInclude;

const leadListInclude = {
  ...leadListIncludeMinimal,
  product: true,
  tags: { include: { tag: true } },
  flags: { include: { flag: true } },
} satisfies Prisma.LeadInclude;

export async function getLeadViewBySlug(organizationId: string, slug: string) {
  return prisma.leadView.findFirst({
    where: { organizationId, slug, isActive: true },
  });
}

async function loadLeadNavViews(organizationId: string) {
  const hiddenNavCategories = ["ADMISSION", "FLAGGED"] as const;
  const hiddenNavSlugs = [
    "due-24h",
    "due-48h",
    "due-72h",
    // Overlaps with New Leads (all status NEW)
    "new-inquiry",
  ] as const;
  const views = await prisma.leadView.findMany({
    where: {
      organizationId,
      isActive: true,
      category: { notIn: [...hiddenNavCategories] },
      slug: { notIn: [...hiddenNavSlugs] },
    },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    select: {
      slug: true,
      name: true,
      category: true,
      href: true,
    },
  });

  const categoryLabels: Record<string, string> = {
    HOME: "HOME",
    REPORTS: "REPORTS",
  };

  const grouped = new Map<string, typeof views>();
  for (const view of views) {
    const key = view.category;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(view);
  }

  const seenHrefs = new Set<string>(["/leads/tasks", "/leads/import"]);

  return Array.from(grouped.entries()).map(([category, items]) => ({
    title: categoryLabels[category] ?? category,
    category,
    items: items
      .map((v) => ({
        href: v.href ?? `/leads/view/${v.slug}`,
        label: v.name,
        slug: v.slug,
      }))
      .filter((item) => {
        if (seenHrefs.has(item.href)) return false;
        seenHrefs.add(item.href);
        return true;
      }),
  })).filter((group) => group.items.length > 0);
}

export const getLeadNavViews = cache((organizationId: string) =>
  orgCache("lead-nav", organizationId, () => loadLeadNavViews(organizationId), 300),
);

async function resolveListContext(
  tenant: TenantContext,
  raw: Record<string, string | string[] | undefined>,
) {
  const parsed = parseLeadListQuery(raw);
  const slug = typeof raw.slug === "string" ? raw.slug : undefined;
  let leadView = null;
  let viewFilters: Prisma.LeadWhereInput = {};

  if (slug) {
    leadView = await getLeadViewBySlug(tenant.organizationId, slug);
    if (leadView?.href && !leadView.filters) {
      return { parsed, leadView, viewFilters, redirectHref: leadView.href };
    }
    if (leadView) {
      const filterConfig = parseViewFilterConfig(leadView.filters);
      if (leadView.href && Object.keys(filterConfig).length === 0) {
        return { parsed, leadView, viewFilters, redirectHref: leadView.href };
      }
      const org = await prisma.organization.findUnique({
        where: { id: tenant.organizationId },
        select: { timezone: true },
      });
      viewFilters = resolveViewFilters(
        parseViewFilterConfig(leadView.filters),
        org?.timezone ?? "UTC",
      );
    }
  }

  const where = leadListWhere(tenant, parsed, viewFilters);
  return { parsed, leadView, viewFilters, where, redirectHref: null as string | null };
}

export async function listLeads(
  tenant: TenantContext,
  raw: Record<string, string | string[] | undefined>,
) {
  const ctx = await resolveListContext(tenant, raw);
  if (ctx.redirectHref) {
    return {
      total: 0,
      rows: [],
      page: ctx.parsed.page,
      pageSize: ctx.parsed.pageSize,
      parsed: ctx.parsed,
      leadView: ctx.leadView,
      redirectHref: ctx.redirectHref,
    };
  }

  const sortField =
    ctx.leadView?.sort && ctx.leadView.sort in { createdAt: 1, fullName: 1, leadScore: 1, nextFollowUpAt: 1, reEngagedAt: 1 }
      ? ctx.leadView.sort
      : ctx.parsed.sort;
  const sortDir =
    (ctx.leadView?.sortDir as "asc" | "desc" | undefined) ?? ctx.parsed.dir;
  const skip = (ctx.parsed.page - 1) * ctx.parsed.pageSize;

  const [total, rows] = await Promise.all([
    prisma.lead.count({ where: ctx.where! }),
    prisma.lead.findMany({
      where: ctx.where!,
      include: leadListInclude,
      orderBy: { [sortField]: sortDir },
      skip,
      take: ctx.parsed.pageSize,
    }),
  ]);

  return {
    total,
    rows,
    page: ctx.parsed.page,
    pageSize: ctx.parsed.pageSize,
    parsed: ctx.parsed,
    leadView: ctx.leadView,
    redirectHref: null,
  };
}

export async function listLeadsForKanban(
  tenant: TenantContext,
  raw: Record<string, string | string[] | undefined>,
) {
  const ctx = await resolveListContext(tenant, raw);
  if (ctx.redirectHref || !ctx.where) {
    return { rows: [], parsed: ctx.parsed, leadView: ctx.leadView };
  }
  const rows = await prisma.lead.findMany({
    where: ctx.where,
    include: leadListInclude,
    orderBy: { updatedAt: "desc" },
    take: 400,
  });
  return { rows, parsed: ctx.parsed, leadView: ctx.leadView };
}

export async function getLeadListStats(
  tenant: TenantContext,
  raw: Record<string, string | string[] | undefined>,
) {
  const ctx = await resolveListContext(tenant, raw);
  if (!ctx.where) {
    return { total: 0, newLeads: 0, converted: 0, lost: 0, followUpsDue: 0 };
  }

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const [grouped, followUpsDue] = await Promise.all([
    prisma.lead.groupBy({
      by: ["status"],
      where: ctx.where,
      _count: { _all: true },
    }),
    prisma.leadFollowUp.count({
      where: {
        organizationId: tenant.organizationId,
        status: "PENDING",
        dueAt: { gte: startOfToday, lte: endOfToday },
        lead: ctx.where,
      },
    }),
  ]);

  const countByStatus = Object.fromEntries(
    grouped.map((row) => [row.status, row._count._all]),
  );
  const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
  return {
    total,
    newLeads: countByStatus.NEW ?? 0,
    converted: countByStatus.CONVERTED ?? 0,
    lost: countByStatus.LOST ?? 0,
    followUpsDue,
  };
}

export async function getLeadReportsSummary(organizationId: string) {
  const base = { organizationId, archivedAt: null as Date | null };

  const [charts, byStatus, interestedCount, byProductRows, products, byLostReason, transferCount, reengagementCount, byPriority] =
    await Promise.all([
      getLeadDashboardCharts(organizationId),
      prisma.lead.groupBy({
        by: ["status"],
        where: base,
        _count: { _all: true },
      }),
      prisma.lead.count({
        where: { ...base, productId: { not: null } },
      }),
      prisma.lead.groupBy({
        by: ["productId"],
        where: { ...base, productId: { not: null } },
        _count: { _all: true },
      }),
      prisma.leadProduct.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
      prisma.lead.groupBy({
        by: ["lostReason"],
        where: { ...base, status: "LOST", lostReason: { not: null } },
        _count: { _all: true },
      }),
      prisma.leadTransfer.count({ where: { organizationId } }),
      prisma.leadReengagement.count({ where: { organizationId } }),
      prisma.lead.groupBy({
        by: ["priority"],
        where: base,
        _count: { _all: true },
      }),
    ]);

  const productName = new Map(products.map((p) => [p.id, p.name]));
  const statusCounts = Object.fromEntries(
    byStatus.map((row) => [row.status, row._count._all]),
  );
  const total = byStatus.reduce((sum, row) => sum + row._count._all, 0);

  return {
    total,
    statusCounts,
    interestedCount,
    lostCount: statusCounts.LOST ?? 0,
    closedCount: statusCounts.CONVERTED ?? 0,
    byProduct: byProductRows.map((row) => ({
      label: row.productId
        ? productName.get(row.productId) ?? "Unknown"
        : "Unspecified",
      value: row._count._all,
    })),
    byLostReason: byLostReason.map((row) => ({
      label: row.lostReason ?? "Unknown",
      value: row._count._all,
    })),
    byPriority: byPriority.map((row) => ({
      label: row.priority,
      value: row._count._all,
    })),
    transferCount,
    reengagementCount,
    charts,
  };
}

export async function getLeadLookups(organizationId: string) {
  return orgCache("lead-lookups", organizationId, () => loadLeadLookups(organizationId), 300);
}

async function loadLeadLookups(organizationId: string) {
  const [sourcesResult, pipelinesResult, members, teams, tags, products, flags, customFields] =
    await Promise.all([
      prisma.leadSource.findMany({
        where: { organizationId, isActive: true },
        orderBy: { name: "asc" },
      }),
      prisma.pipeline.findMany({
        where: { organizationId, isActive: true },
        include: { stages: { orderBy: { sortOrder: "asc" } } },
        orderBy: { name: "asc" },
      }),
      prisma.organizationMember.findMany({
        where: { organizationId, status: "ACTIVE" },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      prisma.team.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
      }),
      prisma.leadTag.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
      }),
      prisma.leadProduct.findMany({
        where: { organizationId, isActive: true },
        orderBy: { name: "asc" },
      }),
      prisma.leadFlagDefinition.findMany({
        where: { organizationId, isActive: true },
        orderBy: { sortOrder: "asc" },
      }),
      prisma.leadCustomFieldDefinition.findMany({
        where: { organizationId, isActive: true },
        orderBy: [{ section: "asc" }, { sortOrder: "asc" }],
      }),
    ]);

  let sources = sourcesResult;
  let pipelines = pipelinesResult;

  if (sources.length === 0 || pipelines.length === 0) {
    await seedOrganizationLeadDefaults(prisma, organizationId);
    [sources, pipelines] = await Promise.all([
      prisma.leadSource.findMany({
        where: { organizationId, isActive: true },
        orderBy: { name: "asc" },
      }),
      prisma.pipeline.findMany({
        where: { organizationId, isActive: true },
        include: { stages: { orderBy: { sortOrder: "asc" } } },
        orderBy: { name: "asc" },
      }),
    ]);
  }

  // Do not run full ensure* upserts on this hot path — Vercel uses
  // connection_limit=1 and parallel list/stats queries will exhaust the pool.
  // Defaults are seeded at org creation; missing views are filled lazily below.
  await ensureMissingSystemLeadViews(prisma, organizationId);

  const stages = pipelines.flatMap((p) => p.stages);
  return { sources, pipelines, stages, members, teams, tags, products, flags, customFields };
}

export const EMPTY_DASHBOARD_STATS = {
  total: 0,
  newLeads: 0,
  assignedToMe: 0,
  contacted: 0,
  qualified: 0,
  converted: 0,
  lost: 0,
  followUpsDue: 0,
  overdueFollowUps: 0,
  conversionRate: 0,
  pipelineValue: 0,
};

export async function getLeadDashboardStats(
  organizationId: string,
  userId: string,
) {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const base = { organizationId, archivedAt: null };

  const grouped = await prisma.lead.groupBy({
    by: ["status"],
    where: base,
    _count: { _all: true },
    _sum: { expectedValue: true },
  });

  const countByStatus = Object.fromEntries(
    grouped.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;

  const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
  const converted = countByStatus.CONVERTED ?? 0;
  const pipelineValue = grouped
    .filter((row) => row.status !== "LOST" && row.status !== "CONVERTED")
    .reduce((sum, row) => sum + Number(row._sum.expectedValue ?? 0), 0);

  const [assignedToMe, followUpsDue, overdueFollowUps] = await Promise.all([
    prisma.lead.count({
      where: { ...base, assignedUserId: userId },
    }),
    prisma.leadFollowUp.count({
      where: {
        organizationId,
        status: "PENDING",
        dueAt: { gte: startOfToday, lte: endOfToday },
      },
    }),
    prisma.leadFollowUp.count({
      where: {
        organizationId,
        status: "PENDING",
        dueAt: { lt: startOfToday },
      },
    }),
  ]);

  const conversionRate =
    total > 0 ? Math.round((converted / total) * 1000) / 10 : 0;

  return {
    total,
    newLeads: countByStatus.NEW ?? 0,
    assignedToMe,
    contacted: (countByStatus.OPEN ?? 0) + (countByStatus.IN_PROGRESS ?? 0),
    qualified: countByStatus.QUALIFIED ?? 0,
    converted,
    lost: countByStatus.LOST ?? 0,
    followUpsDue,
    overdueFollowUps,
    conversionRate,
    pipelineValue,
  };
}

export async function getLeadDashboardCharts(organizationId: string) {
  const base = { organizationId, archivedAt: null as Date | null };

  const [bySource, byStage, byAssignee, overTimeRows, sources, stages] =
    await Promise.all([
      prisma.lead.groupBy({
        by: ["sourceId"],
        where: base,
        _count: { _all: true },
      }),
      prisma.lead.groupBy({
        by: ["stageId"],
        where: base,
        _count: { _all: true },
      }),
      prisma.lead.groupBy({
        by: ["assignedUserId"],
        where: base,
        _count: { _all: true },
        _sum: { expectedValue: true },
      }),
      prisma.$queryRaw<
        { label: string; created: number; converted: number }[]
      >`
        SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS label,
          COUNT(*)::int AS created,
          COUNT(*) FILTER (WHERE status::text = 'CONVERTED')::int AS converted
        FROM leads
        WHERE "organizationId" = ${organizationId}
          AND "archivedAt" IS NULL
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.leadSource.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
      prisma.leadStage.findMany({
        where: { organizationId },
        select: { id: true, name: true, color: true },
      }),
    ]);

  const assigneeIds = byAssignee
    .map((row) => row.assignedUserId)
    .filter((id): id is string => Boolean(id));
  const members =
    assigneeIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true, email: true },
        });

  const sourceName = new Map(sources.map((s) => [s.id, s.name]));
  const stageName = new Map(stages.map((s) => [s.id, s]));
  const userName = new Map(
    members.map((u) => [u.id, u.name || u.email || "Unassigned"]),
  );

  return {
    bySource: bySource.map((row) => ({
      label: row.sourceId ? sourceName.get(row.sourceId) ?? "Unknown" : "Unspecified",
      value: row._count._all,
    })),
    byStage: byStage.map((row) => ({
      label: row.stageId ? stageName.get(row.stageId)?.name ?? "Unknown" : "Unspecified",
      color: row.stageId ? stageName.get(row.stageId)?.color : undefined,
      value: row._count._all,
    })),
    byAssignee: byAssignee.map((row) => ({
      label: row.assignedUserId
        ? userName.get(row.assignedUserId) ?? "Unknown"
        : "Unassigned",
      value: row._count._all,
      pipelineValue: Number(row._sum.expectedValue ?? 0),
    })),
    overTime: overTimeRows.map((row) => ({
      label: row.label,
      created: row.created,
      converted: row.converted,
      conversionRate:
        row.created > 0
          ? Math.round((row.converted / row.created) * 1000) / 10
          : 0,
    })),
  };
}

export async function listReEngagedLeads(
  tenant: TenantContext,
  raw: Record<string, string | string[] | undefined> = {},
) {
  const parsed = parseLeadListQuery(raw);

  const baseWhere: Prisma.LeadWhereInput = {
    ...leadVisibilityWhere(tenant),
    archivedAt: null,
    reEngagedAt: { not: null },
  };

  const where: Prisma.LeadWhereInput = { ...baseWhere };
  if (parsed.status) where.status = parsed.status;
  if (parsed.sourceId) where.sourceId = parsed.sourceId;
  if (parsed.priority) where.priority = parsed.priority;
  if (parsed.assignedUserId) where.assignedUserId = parsed.assignedUserId;
  if (parsed.q) {
    where.OR = [
      { fullName: { contains: parsed.q, mode: "insensitive" } },
      { company: { contains: parsed.q, mode: "insensitive" } },
      { email: { contains: parsed.q, mode: "insensitive" } },
      { phone: { contains: parsed.q, mode: "insensitive" } },
    ];
  }

  const skip = (parsed.page - 1) * parsed.pageSize;
  const [total, rows] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      include: leadListIncludeMinimal,
      orderBy: { reEngagedAt: "desc" },
      skip,
      take: parsed.pageSize,
    }),
  ]);

  return { total, rows, page: parsed.page, pageSize: parsed.pageSize, parsed };
}

export async function getLeadDetail(tenant: TenantContext, id: string) {
  return prisma.lead.findFirst({
    where: { id, ...leadVisibilityWhere(tenant) },
    include: {
      source: true,
      product: true,
      stage: true,
      assignedUser: true,
      assignedTeam: true,
      tags: { include: { tag: true } },
      flags: { include: { flag: true } },
      customFieldValues: { include: { field: true } },
      notes: { include: { author: true }, orderBy: { createdAt: "desc" } },
      tasks: { orderBy: { createdAt: "desc" } },
      followUps: { orderBy: { dueAt: "asc" } },
      callRecords: {
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { calledAt: "desc" },
        take: 50,
      },
      transfers: {
        include: {
          fromUser: { select: { id: true, name: true, email: true } },
          toUser: { select: { id: true, name: true, email: true } },
          transferredBy: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
      reengagements: {
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          assignedUser: { select: { id: true, name: true, email: true } },
        },
        orderBy: { reengagedAt: "desc" },
        take: 10,
      },
      activities: {
        include: { actor: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
      communications: {
        where: { type: "EMAIL" },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { occurredAt: "desc" },
        take: 30,
      },
    },
  });
}

export async function listLeadEmails(tenant: TenantContext, limit = 200) {
  return prisma.leadCommunication.findMany({
    where: {
      organizationId: tenant.organizationId,
      type: "EMAIL",
      lead: leadVisibilityWhere(tenant),
    },
    include: {
      lead: { select: { id: true, fullName: true, email: true } },
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
}

export async function listLeadTransfers(tenant: TenantContext) {
  return prisma.leadTransfer.findMany({
    where: { organizationId: tenant.organizationId },
    include: {
      lead: { select: { id: true, fullName: true } },
      fromUser: { select: { id: true, name: true, email: true } },
      toUser: { select: { id: true, name: true, email: true } },
      transferredBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function listFollowUps(tenant: TenantContext) {
  return prisma.leadFollowUp.findMany({
    where: {
      organizationId: tenant.organizationId,
      lead: leadVisibilityWhere(tenant),
    },
    include: { lead: { select: { id: true, fullName: true } } },
    orderBy: { dueAt: "asc" },
    take: 200,
  });
}

export async function listTasks(tenant: TenantContext) {
  return prisma.leadTask.findMany({
    where: {
      organizationId: tenant.organizationId,
      lead: leadVisibilityWhere(tenant),
    },
    include: { lead: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
