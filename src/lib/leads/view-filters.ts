import type { Prisma, LeadStatus } from "@prisma/client";
import { addHours } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

export type LeadViewFilterConfig = {
  status?: string;
  stageId?: string;
  sourceId?: string;
  priority?: string;
  assignedUserId?: string;
  productId?: string;
  interested?: boolean;
  reengaged?: boolean;
  dueWithinHours?: number;
  overdueHours?: number;
  followUpDue?: boolean;
  scoreMin?: number;
  scoreMax?: number;
  flagKeys?: string[];
  excludeStatuses?: string[];
  recentDays?: number;
  hasRecentCalls?: boolean;
  stageIsWon?: boolean;
  stageIsLost?: boolean;
  stageName?: string;
};

export const CRM_LIST_COLUMNS = [
  "leadId",
  "name",
  "source",
  "leadDate",
  "status",
] as const;

export const REENGAGED_LIST_COLUMNS = [
  "leadId",
  "name",
  "source",
  "leadDate",
  "reengagedDate",
  "dueCall",
  "status",
] as const;

export const DEFAULT_LIST_COLUMNS = [
  "leadId",
  "name",
  "company",
  "source",
  "leadDate",
  "stage",
  "status",
  "priority",
  "assigned",
  "score",
  "nextFollowUp",
] as const;

export type ListColumnKey = (typeof DEFAULT_LIST_COLUMNS)[number] | string;

function nowInTimezone(timezone: string) {
  return toZonedTime(new Date(), timezone);
}

function toUtcFromOrgLocal(date: Date, timezone: string) {
  return fromZonedTime(date, timezone);
}

export function buildDueWindowFilter(
  timezone: string,
  hours: number,
  mode: "within" | "overdue",
): Prisma.LeadWhereInput {
  const nowLocal = nowInTimezone(timezone);
  const nowUtc = toUtcFromOrgLocal(nowLocal, timezone);

  if (mode === "within") {
    const endUtc = addHours(nowUtc, hours);
    return {
      OR: [
        {
          followUps: {
            some: {
              status: "PENDING",
              dueAt: { gte: nowUtc, lte: endUtc },
            },
          },
        },
        { nextFollowUpAt: { gte: nowUtc, lte: endUtc } },
        { callbackAt: { gte: nowUtc, lte: endUtc } },
      ],
    };
  }

  const thresholdUtc = addHours(nowUtc, -hours);
  return {
    OR: [
      {
        followUps: {
          some: {
            status: "PENDING",
            dueAt: { lt: thresholdUtc },
          },
        },
      },
      { nextFollowUpAt: { lt: thresholdUtc } },
      { callbackAt: { lt: thresholdUtc } },
    ],
  };
}

export function buildFollowUpDueFilter(timezone: string): Prisma.LeadWhereInput {
  const nowLocal = nowInTimezone(timezone);
  const endOfDayLocal = new Date(nowLocal);
  endOfDayLocal.setHours(23, 59, 59, 999);
  const endUtc = toUtcFromOrgLocal(endOfDayLocal, timezone);

  return {
    OR: [
      {
        followUps: {
          some: {
            status: "PENDING",
            dueAt: { lte: endUtc },
          },
        },
      },
      { nextFollowUpAt: { lte: endUtc } },
      { callbackAt: { lte: endUtc } },
    ],
    NOT: {
      AND: [
        { nextFollowUpAt: null },
        { callbackAt: null },
        { followUps: { none: { status: "PENDING" } } },
      ],
    },
  };
}

export function resolveViewFilters(
  filters: LeadViewFilterConfig | null | undefined,
  timezone = "UTC",
): Prisma.LeadWhereInput {
  if (!filters) return {};

  const where: Prisma.LeadWhereInput = {};

  if (filters.status) where.status = filters.status as Prisma.EnumLeadStatusFilter;
  if (filters.stageId) where.stageId = filters.stageId;
  if (filters.sourceId) where.sourceId = filters.sourceId;
  if (filters.priority) where.priority = filters.priority as Prisma.EnumLeadPriorityFilter;
  if (filters.assignedUserId) where.assignedUserId = filters.assignedUserId;
  if (filters.productId) where.productId = filters.productId;
  if (filters.interested) where.productId = { not: null };
  if (filters.reengaged) where.reEngagedAt = { not: null };

  if (filters.scoreMin != null || filters.scoreMax != null) {
    where.leadScore = {
      ...(filters.scoreMin != null ? { gte: filters.scoreMin } : {}),
      ...(filters.scoreMax != null ? { lte: filters.scoreMax } : {}),
    };
  }

  if (filters.flagKeys?.length) {
    where.flags = {
      some: { flag: { key: { in: filters.flagKeys }, isActive: true } },
    };
  }

  if (filters.excludeStatuses?.length) {
    where.status = { notIn: filters.excludeStatuses as LeadStatus[] };
  }

  if (filters.recentDays) {
    const since = new Date();
    since.setDate(since.getDate() - filters.recentDays);
    where.createdAt = { gte: since };
  }

  const stageFilter: Prisma.LeadStageWhereInput = {};
  if (filters.stageName) stageFilter.name = filters.stageName;
  if (filters.stageIsWon != null) stageFilter.isWon = filters.stageIsWon;
  if (filters.stageIsLost != null) stageFilter.isLost = filters.stageIsLost;
  if (Object.keys(stageFilter).length > 0) {
    where.stage = stageFilter;
  }

  if (filters.hasRecentCalls) {
    const since = new Date();
    since.setDate(since.getDate() - 7);
    where.callRecords = { some: { calledAt: { gte: since } } };
  }

  const extra: Prisma.LeadWhereInput[] = [];

  if (filters.dueWithinHours) {
    extra.push(buildDueWindowFilter(timezone, filters.dueWithinHours, "within"));
  }
  if (filters.overdueHours) {
    extra.push(buildDueWindowFilter(timezone, filters.overdueHours, "overdue"));
  }
  if (filters.followUpDue) {
    extra.push(buildFollowUpDueFilter(timezone));
  }

  if (extra.length === 1) {
    return { ...where, ...extra[0] };
  }
  if (extra.length > 1) {
    return { AND: [where, ...extra] };
  }

  return where;
}

export function parseViewFilterConfig(raw: unknown): LeadViewFilterConfig {
  if (!raw || typeof raw !== "object") return {};
  return raw as LeadViewFilterConfig;
}

export function formatDueCallLabel(
  nextFollowUpAt: Date | null | undefined,
  callbackAt: Date | null | undefined,
  timezone = "UTC",
): string | null {
  const dates = [nextFollowUpAt, callbackAt].filter(Boolean) as Date[];
  if (dates.length === 0) return null;

  const nowLocal = nowInTimezone(timezone);
  const nowUtc = toUtcFromOrgLocal(nowLocal, timezone);
  const nearest = dates.sort((a, b) => a.getTime() - b.getTime())[0];
  const diffMs = nearest.getTime() - nowUtc.getTime();
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));

  if (diffHours < 0) {
    const overdue = Math.abs(diffHours);
    if (overdue <= 24) return "24 hrs overdue";
    if (overdue <= 48) return "48 hrs overdue";
    if (overdue <= 72) return "72 hrs overdue";
    return `${overdue}h overdue`;
  }
  if (diffHours <= 24) return "24 hrs";
  if (diffHours <= 48) return "48 hrs";
  if (diffHours <= 72) return "72 hrs";
  return `${diffHours}h`;
}
