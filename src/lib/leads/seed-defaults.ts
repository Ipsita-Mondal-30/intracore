import type { Prisma, PrismaClient } from "@prisma/client";
import { CustomFieldType, LeadViewCategory } from "@prisma/client";
import type { LeadViewFilterConfig } from "@/lib/leads/view-filters";
import { DEFAULT_LIST_COLUMNS } from "@/lib/leads/view-filters";

type DbClient = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_LEAD_SOURCES = [
  { code: "website", name: "Website" },
  { code: "manual", name: "Manual entry" },
  { code: "import", name: "Import" },
  { code: "instagram", name: "Instagram" },
  { code: "facebook", name: "Facebook" },
  { code: "whatsapp", name: "WhatsApp" },
  { code: "linkedin", name: "LinkedIn" },
  { code: "google", name: "Google" },
  { code: "pinterest", name: "Pinterest" },
  { code: "other_social", name: "Other social media" },
  { code: "search", name: "Search engines" },
  { code: "referral", name: "Referral" },
  { code: "campaign", name: "Campaign" },
  { code: "other", name: "Other" },
] as const;

export const DEFAULT_STAGES = [
  { name: "New", sortOrder: 0, probability: 10, color: "#2F6BFF", isWon: false, isLost: false },
  { name: "Contacted", sortOrder: 1, probability: 25, color: "#7C5CFF", isWon: false, isLost: false },
  { name: "Qualified", sortOrder: 2, probability: 50, color: "#2EC4B6", isWon: false, isLost: false },
  { name: "Potential", sortOrder: 3, probability: 60, color: "#6366F1", isWon: false, isLost: false },
  { name: "Proposal", sortOrder: 4, probability: 70, color: "#FF8A3D", isWon: false, isLost: false },
  { name: "Negotiation", sortOrder: 5, probability: 85, color: "#F5C542", isWon: false, isLost: false },
  { name: "Admission Finalizing", sortOrder: 6, probability: 90, color: "#0EA5E9", isWon: false, isLost: false },
  { name: "Won", sortOrder: 7, probability: 100, color: "#16A34A", isWon: true, isLost: false },
  { name: "Lost", sortOrder: 8, probability: 0, color: "#EF4444", isWon: false, isLost: true },
] as const;

export const DEFAULT_EDUCATION_CUSTOM_FIELDS = [
  {
    key: "gender",
    label: "Gender",
    type: CustomFieldType.SELECT,
    section: "education",
    sortOrder: 0,
    options: ["Male", "Female"],
  },
  {
    key: "category",
    label: "Category",
    type: CustomFieldType.SELECT,
    section: "education",
    sortOrder: 1,
    options: ["GEN", "SC/ST", "OBC", "Others"],
  },
  {
    key: "location",
    label: "Location",
    type: CustomFieldType.TEXT,
    section: "education",
    sortOrder: 2,
  },
  {
    key: "school_name",
    label: "School Name",
    type: CustomFieldType.TEXT,
    section: "education",
    sortOrder: 3,
  },
  {
    key: "stream",
    label: "Stream",
    type: CustomFieldType.TEXT,
    section: "education",
    sortOrder: 4,
  },
  {
    key: "course",
    label: "Course",
    type: CustomFieldType.TEXT,
    section: "education",
    sortOrder: 5,
  },
  {
    key: "last_institute",
    label: "Last Institute",
    type: CustomFieldType.TEXT,
    section: "education",
    sortOrder: 6,
  },
  {
    key: "cgpa",
    label: "CGPA",
    type: CustomFieldType.TEXT,
    section: "education",
    sortOrder: 7,
  },
  {
    key: "last_std",
    label: "Last STD",
    type: CustomFieldType.TEXT,
    section: "education",
    sortOrder: 8,
  },
  {
    key: "discount_fees",
    label: "Discount in fees",
    type: CustomFieldType.SELECT,
    section: "education",
    sortOrder: 9,
    options: ["10%", "15%", "20%"],
  },
] as const;

export const DEFAULT_FLAG_DEFINITIONS = [
  { key: "hot", label: "Hot", color: "#EF4444", sortOrder: 0 },
  { key: "warm", label: "Warm", color: "#F97316", sortOrder: 1 },
  { key: "cold", label: "Cold", color: "#64748B", sortOrder: 2 },
] as const;

type SystemViewSeed = {
  slug: string;
  name: string;
  category: LeadViewCategory;
  sortOrder: number;
  filters?: LeadViewFilterConfig;
  href?: string;
  columns?: string[];
  sort?: string;
  sortDir?: string;
};

export const SYSTEM_LEAD_VIEWS: SystemViewSeed[] = [
  { slug: "new-leads", name: "New Leads", category: "HOME", sortOrder: 1, filters: { status: "NEW" } },
  { slug: "create-lead", name: "Create New Lead", category: "HOME", sortOrder: 10, href: "/leads/new" },
  { slug: "messages", name: "Messages", category: "HOME", sortOrder: 11, href: "/leads/messages" },
  { slug: "email", name: "E-mail", category: "HOME", sortOrder: 12, href: "/leads/email" },
  { slug: "re-engaged", name: "Re-engaged", category: "HOME", sortOrder: 2, filters: { reengaged: true }, columns: ["leadId", "name", "source", "leadDate", "reengagedDate", "dueCall", "status", "assigned"], sort: "reEngagedAt", sortDir: "desc" },
  { slug: "due-24h", name: "24 Hrs Due", category: "HOME", sortOrder: 3, filters: { dueWithinHours: 24 }, columns: ["leadId", "name", "source", "leadDate", "dueCall", "status", "assigned"] },
  { slug: "due-48h", name: "48 Hrs Due", category: "HOME", sortOrder: 4, filters: { dueWithinHours: 48 }, columns: ["leadId", "name", "source", "leadDate", "dueCall", "status", "assigned"] },
  { slug: "due-72h", name: "72 Hrs Due", category: "HOME", sortOrder: 5, filters: { dueWithinHours: 72 }, columns: ["leadId", "name", "source", "leadDate", "dueCall", "status", "assigned"] },
  { slug: "follow-up-due", name: "Follow-up Due", category: "HOME", sortOrder: 6, filters: { followUpDue: true }, href: "/leads/follow-ups" },
  { slug: "call-notes", name: "Call Notes", category: "HOME", sortOrder: 7, filters: { hasRecentCalls: true } },
  { slug: "new-inquiry", name: "New Inquiry", category: "HOME", sortOrder: 8, filters: { status: "NEW", recentDays: 14 } },
  { slug: "lost-leads", name: "Lost Leads", category: "HOME", sortOrder: 9, filters: { status: "LOST" } },
  { slug: "all-admission", name: "All Admission", category: "ADMISSION", sortOrder: 1, filters: { excludeStatuses: ["LOST"] } },
  { slug: "potential", name: "Potential", category: "ADMISSION", sortOrder: 2, filters: { status: "QUALIFIED" } },
  { slug: "admission-lost", name: "Lost", category: "ADMISSION", sortOrder: 3, filters: { status: "LOST" } },
  { slug: "confirmed", name: "Confirmed", category: "ADMISSION", sortOrder: 4, filters: { status: "CONVERTED" } },
  { slug: "hot-leads", name: "Hot Leads", category: "FLAGGED", sortOrder: 1, filters: { flagKeys: ["hot"] } },
  { slug: "warm-leads", name: "Warm Leads", category: "FLAGGED", sortOrder: 2, filters: { flagKeys: ["warm"] } },
  { slug: "red-flag", name: "Red Flag", category: "FLAGGED", sortOrder: 3, filters: { flagKeys: ["red_flag"] } },
  { slug: "high-scoring", name: "High Scoring Leads", category: "FLAGGED", sortOrder: 4, filters: { scoreMin: 70 } },
  { slug: "all-leads", name: "All Leads", category: "FLAGGED", sortOrder: 5, filters: {} },
  { slug: "transfer-leads", name: "Transfer Leads", category: "REPORTS", sortOrder: 1, href: "/leads/transfers" },
  { slug: "reports", name: "Reports", category: "REPORTS", sortOrder: 2, href: "/leads/reports" },
  { slug: "reports-all-leads", name: "All Leads", category: "REPORTS", sortOrder: 3, filters: {} },
];

export async function seedOrganizationLeadDefaults(
  db: DbClient,
  organizationId: string,
) {
  await db.leadSource.createMany({
    data: DEFAULT_LEAD_SOURCES.map((source) => ({
      organizationId,
      code: source.code,
      name: source.name,
      isSystem: true,
    })),
    skipDuplicates: true,
  });

  const existingPipeline = await db.pipeline.findFirst({
    where: { organizationId, isDefault: true },
  });

  let pipelineId = existingPipeline?.id;
  if (!pipelineId) {
    const pipeline = await db.pipeline.create({
      data: {
        organizationId,
        name: "Default",
        isDefault: true,
      },
    });
    pipelineId = pipeline.id;

    await db.leadStage.createMany({
      data: DEFAULT_STAGES.map((stage) => ({
        organizationId,
        pipelineId: pipeline.id,
        name: stage.name,
        sortOrder: stage.sortOrder,
        probability: stage.probability,
        color: stage.color,
        isWon: stage.isWon,
        isLost: stage.isLost,
      })),
    });
  }

  await db.leadFlagDefinition.createMany({
    data: DEFAULT_FLAG_DEFINITIONS.map((flag) => ({
      organizationId,
      key: flag.key,
      label: flag.label,
      color: flag.color,
      sortOrder: flag.sortOrder,
    })),
    skipDuplicates: true,
  });

  await db.leadView.createMany({
    data: SYSTEM_LEAD_VIEWS.map((view) => ({
      organizationId,
      slug: view.slug,
      name: view.name,
      category: view.category,
      sortOrder: view.sortOrder,
      filters: (view.filters ?? {}) as Prisma.InputJsonValue,
      columns: (view.columns ?? DEFAULT_LIST_COLUMNS) as Prisma.InputJsonValue,
      sort: view.sort ?? "createdAt",
      sortDir: view.sortDir ?? "desc",
      href: view.href ?? null,
      isSystem: true,
      isActive: true,
    })),
    skipDuplicates: true,
  });

  await seedEducationCustomFields(db, organizationId);

  return pipelineId;
}

export async function seedEducationCustomFields(
  db: DbClient,
  organizationId: string,
) {
  await db.leadCustomFieldDefinition.createMany({
    data: DEFAULT_EDUCATION_CUSTOM_FIELDS.map((field) => ({
      organizationId,
      key: field.key,
      label: field.label,
      type: field.type,
      section: field.section,
      sortOrder: field.sortOrder,
      options: "options" in field ? field.options : undefined,
    })),
    skipDuplicates: true,
  });
}

export async function ensureEducationCustomFields(
  db: DbClient,
  organizationId: string,
) {
  const count = await db.leadCustomFieldDefinition.count({
    where: { organizationId, section: "education" },
  });
  if (count > 0) return;
  await seedEducationCustomFields(db, organizationId);
}

/** Lightweight: only insert missing system views (no per-view upserts). */
export async function ensureMissingSystemLeadViews(
  db: DbClient,
  organizationId: string,
) {
  const existing = await db.leadView.findMany({
    where: { organizationId },
    select: { slug: true },
  });
  if (existing.length === 0) {
    await seedOrganizationLeadDefaults(db, organizationId);
    return;
  }

  const have = new Set(existing.map((v) => v.slug));
  const missing = SYSTEM_LEAD_VIEWS.filter((view) => !have.has(view.slug));
  if (missing.length === 0) return;

  await db.leadView.createMany({
    data: missing.map((view) => ({
      organizationId,
      slug: view.slug,
      name: view.name,
      category: view.category,
      sortOrder: view.sortOrder,
      filters: (view.filters ?? {}) as Prisma.InputJsonValue,
      columns: (view.columns ?? DEFAULT_LIST_COLUMNS) as Prisma.InputJsonValue,
      sort: view.sort ?? "createdAt",
      sortDir: view.sortDir ?? "desc",
      href: view.href ?? null,
      isSystem: true,
      isActive: true,
    })),
    skipDuplicates: true,
  });
}

export async function ensureOrganizationLeadViews(
  db: DbClient,
  organizationId: string,
) {
  const count = await db.leadView.count({ where: { organizationId } });
  if (count === 0) {
    await seedOrganizationLeadDefaults(db, organizationId);
    return;
  }

  const systemSlugs = new Set(SYSTEM_LEAD_VIEWS.map((v) => v.slug));

  await db.leadView.updateMany({
    where: {
      organizationId,
      isSystem: true,
      slug: { notIn: [...systemSlugs] },
    },
    data: { isActive: false },
  });

  for (const view of SYSTEM_LEAD_VIEWS) {
    await db.leadView.upsert({
      where: {
        organizationId_slug: { organizationId, slug: view.slug },
      },
      create: {
        organizationId,
        slug: view.slug,
        name: view.name,
        category: view.category,
        sortOrder: view.sortOrder,
        filters: (view.filters ?? {}) as Prisma.InputJsonValue,
        columns: (view.columns ?? DEFAULT_LIST_COLUMNS) as Prisma.InputJsonValue,
        sort: view.sort ?? "createdAt",
        sortDir: view.sortDir ?? "desc",
        href: view.href ?? null,
        isSystem: true,
        isActive: true,
      },
      update: {
        name: view.name,
        category: view.category,
        sortOrder: view.sortOrder,
        filters: (view.filters ?? {}) as Prisma.InputJsonValue,
        columns: (view.columns ?? DEFAULT_LIST_COLUMNS) as Prisma.InputJsonValue,
        sort: view.sort ?? "createdAt",
        sortDir: view.sortDir ?? "desc",
        href: view.href ?? null,
        isActive: true,
      },
    });
  }

  await ensureEducationCustomFields(db, organizationId);
}
