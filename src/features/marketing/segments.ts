import { z } from "zod";
import { CommunicationType, CustomerType, LeadPriority, LeadStatus, RecordStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import type { TenantContext } from "@/lib/tenant";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { checkConsent, normalizeAddress, type Purpose } from "@/features/communication/send";

/**
 * Segments: a saved audience over customers, customer contacts or leads.
 * Filters are `[{ field, op, value }]`, checked against a per-entity ALLOWLIST and translated to
 * Prisma `where` objects (values are always bound data, never SQL). Unknown fields/ops → 422.
 * Audiences are evaluated when previewed and when a campaign is dispatched, not when saved.
 * Lead segments only ever include leads visible to the caller (lead.view_all or assigned).
 */

type Db = PrismaClient | Prisma.TransactionClient;
export const SEGMENT_ENTITIES = ["CUSTOMER", "CONTACT", "LEAD"] as const;
export type SegmentEntity = (typeof SEGMENT_ENTITIES)[number];

type Kind = { type: "enum"; values: readonly string[] } | { type: "id" } | { type: "string" } | { type: "date" } | { type: "boolean" };
const OPS: Record<Kind["type"], readonly string[]> = {
  enum: ["eq", "neq", "in", "not_in"],
  id: ["eq", "neq", "in", "not_in", "is_set", "not_set"],
  string: ["eq", "neq", "contains", "in", "is_set", "not_set"],
  date: ["gte", "lte"],
  boolean: ["eq"],
};

const customerFields = {
  type: { type: "enum", values: Object.values(CustomerType) },
  status: { type: "enum", values: Object.values(RecordStatus) },
  stateCode: { type: "string" },
  name: { type: "string" },
  ownerUserId: { type: "id" },
  createdAt: { type: "date" },
} satisfies Record<string, Kind>;

export const SEGMENT_FIELDS: Record<SegmentEntity, Record<string, Kind>> = {
  CUSTOMER: customerFields,
  CONTACT: {
    status: { type: "enum", values: Object.values(RecordStatus) },
    isPrimary: { type: "boolean" },
    jobTitle: { type: "string" },
    createdAt: { type: "date" },
    ...Object.fromEntries(Object.entries(customerFields).map(([k, v]) => [`customer.${k}`, v])),
  },
  LEAD: {
    status: { type: "enum", values: Object.values(LeadStatus) },
    priority: { type: "enum", values: Object.values(LeadPriority) },
    sourceId: { type: "id" },
    stageId: { type: "id" },
    assignedUserId: { type: "id" },
    city: { type: "string" },
    state: { type: "string" },
    industry: { type: "string" },
    createdAt: { type: "date" },
  },
};

/** The allowlist as plain data, for the segment builder UI. */
export const segmentFieldCatalog = () =>
  Object.fromEntries(
    SEGMENT_ENTITIES.map((e) => [e, Object.entries(SEGMENT_FIELDS[e]).map(([field, k]) => ({ field, type: k.type, values: "values" in k ? [...k.values] : [], ops: [...OPS[k.type]] }))]),
  ) as Record<SegmentEntity, { field: string; type: Kind["type"]; values: string[]; ops: string[] }[]>;

const filterSchema = z.object({ field: z.string().max(60), op: z.string().max(20), value: z.unknown().optional() });
export const filtersSchema = z.array(filterSchema).max(20).default([]);
export type SegmentFilter = z.infer<typeof filterSchema>;

const bad = (message: string, index: number) => new AppError("VALIDATION_ERROR", message, 422, [{ path: `filters.${index}`, message }]);

/** Validate filters against the allowlist and build the Prisma `where`. Throws 422 on anything unknown. */
export function buildFilterWhere(entity: SegmentEntity, filters: SegmentFilter[]): Record<string, unknown>[] {
  const fields = SEGMENT_FIELDS[entity];
  return filters.map((f, i) => {
    const kind = Object.hasOwn(fields, f.field) ? fields[f.field] : undefined;
    if (!kind) throw bad(`Unknown field "${f.field}" for ${entity.toLowerCase()} segments`, i);
    if (!OPS[kind.type].includes(f.op)) throw bad(`Operator "${f.op}" is not allowed on ${f.field}`, i);
    const one = (v: unknown) => {
      if (kind.type === "date") {
        const d = typeof v === "string" ? new Date(v) : null;
        if (!d || Number.isNaN(d.getTime())) throw bad(`${f.field} needs a date`, i);
        return d;
      }
      if (kind.type === "boolean") {
        if (typeof v !== "boolean") throw bad(`${f.field} needs true or false`, i);
        return v;
      }
      if (typeof v !== "string" || !v.trim() || v.length > 200) throw bad(`${f.field} needs a text value`, i);
      if (kind.type === "enum" && !kind.values.includes(v)) throw bad(`${f.field} must be one of ${kind.values.join(", ")}`, i);
      return v.trim();
    };
    const many = () => {
      if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > 100) throw bad(`${f.field} needs a list of 1–100 values`, i);
      return f.value.map(one);
    };
    const ci = kind.type === "string" ? { mode: "insensitive" as const } : {};
    let cond: unknown;
    switch (f.op) {
      case "eq": cond = kind.type === "string" ? { equals: one(f.value), ...ci } : one(f.value); break;
      case "neq": cond = { not: kind.type === "string" ? { equals: one(f.value), ...ci } : one(f.value) }; break;
      case "contains": cond = { contains: one(f.value), ...ci }; break;
      case "in": cond = { in: many() }; break;
      case "not_in": cond = { notIn: many() }; break;
      case "gte": cond = { gte: one(f.value) }; break;
      case "lte": cond = { lte: one(f.value) }; break;
      case "is_set": cond = { not: null }; break;
      case "not_set": cond = null; break;
    }
    // "customer.type" → { customer: { type: cond } }
    return f.field.split(".").reduceRight<unknown>((acc, key) => ({ [key]: acc }), cond) as Record<string, unknown>;
  });
}

export type AudienceMember = { address: string | null; raw: string; name: string; customerId?: string; contactId?: string; leadId?: string };

/**
 * Every record matching the segment, with its address for the channel (normalized, or null when
 * missing/invalid). `viewer` (required for leads) limits lead segments to leads that user may see.
 * ponytail: loads the whole audience into memory; page with a cursor once segments pass ~100k rows.
 */
export async function resolveAudience(
  db: Db,
  organizationId: string,
  segment: { entity: string; filters: unknown },
  channel: CommunicationType,
  viewer?: TenantContext,
): Promise<AudienceMember[]> {
  const entity = segment.entity as SegmentEntity;
  const and = buildFilterWhere(entity, filtersSchema.parse(segment.filters));
  const addr = (raw: string | null | undefined) => ({ raw: raw?.trim() ?? "", address: raw ? normalizeAddress(channel, raw) : null });
  const phone = channel !== "EMAIL";
  if (entity === "CUSTOMER") {
    const rows = await db.customer.findMany({ where: { organizationId, AND: and }, select: { id: true, name: true, email: true, phone: true }, orderBy: { id: "asc" } });
    return rows.map((r) => ({ ...addr(phone ? r.phone : r.email), name: r.name, customerId: r.id }));
  }
  if (entity === "CONTACT") {
    const rows = await db.contact.findMany({
      where: { organizationId, customerId: { not: null }, AND: and },
      select: { id: true, fullName: true, email: true, phone: true, customerId: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => ({ ...addr(phone ? r.phone : r.email), name: r.fullName, contactId: r.id, customerId: r.customerId ?? undefined }));
  }
  if (!viewer) throw new AppError("FORBIDDEN", "Lead audiences need a user whose lead visibility applies", 403);
  const rows = await db.lead.findMany({
    where: { ...leadVisibilityWhere(viewer), organizationId, archivedAt: null, AND: and },
    select: { id: true, fullName: true, email: true, phone: true, whatsappNumber: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => ({ ...addr(channel === "EMAIL" ? r.email : channel === "WHATSAPP" ? r.whatsappNumber ?? r.phone : r.phone), name: r.fullName, leadId: r.id }));
}

export type AudienceBreakdown = {
  total: number;
  withAddress: number;
  unique: number;
  eligible: number;
  blocked: { NO_CONSENT: number; OPTED_OUT: number; INVALID_ADDRESS: number };
  sample: { name: string; address: string; status: string }[];
};

/**
 * Counts for an audience: matched records, records with a usable address, distinct addresses,
 * and how many distinct addresses pass consent (rules from send.ts `checkConsent`).
 * INVALID_ADDRESS counts records whose address is missing or malformed.
 */
export async function breakdown(db: Db, organizationId: string, members: AudienceMember[], channel: CommunicationType, purpose: Purpose): Promise<AudienceBreakdown> {
  const addresses = [...new Set(members.flatMap((m) => (m.address ? [m.address] : [])))];
  const consents = new Map<string, unknown>();
  for (let i = 0; i < addresses.length; i += 5000) {
    const rows = await db.contactConsent.findMany({ where: { organizationId, channel, purpose, address: { in: addresses.slice(i, i + 5000) } } });
    for (const r of rows) consents.set(r.address, r);
  }
  // checkConsent owns the rules; feed it the prefetched rows instead of one query per address.
  const lookup = { contactConsent: { findUnique: async (args: { where: { organizationId_channel_address_purpose: { address: string } } }) => consents.get(args.where.organizationId_channel_address_purpose.address) ?? null } } as unknown as Db;
  const verdict = new Map<string, string>();
  for (const a of addresses) {
    const c = await checkConsent(lookup, organizationId, channel, a, purpose);
    verdict.set(a, c.allowed ? "ELIGIBLE" : c.reason);
  }
  const blocked = { NO_CONSENT: 0, OPTED_OUT: 0, INVALID_ADDRESS: members.filter((m) => !m.address).length };
  for (const v of verdict.values()) if (v !== "ELIGIBLE") blocked[v as "NO_CONSENT" | "OPTED_OUT"]++;
  return {
    total: members.length,
    withAddress: members.length - blocked.INVALID_ADDRESS,
    unique: addresses.length,
    eligible: [...verdict.values()].filter((v) => v === "ELIGIBLE").length,
    blocked,
    sample: members.slice(0, 20).map((m) => ({ name: m.name, address: m.address ?? m.raw, status: m.address ? verdict.get(m.address)! : "INVALID_ADDRESS" })),
  };
}

const VIEW_PERMISSION: Record<SegmentEntity, string> = { CUSTOMER: "customer.view", CONTACT: "contact.view", LEAD: "lead.view" };

const segmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  entity: z.enum(SEGMENT_ENTITIES),
  filters: filtersSchema,
});

export async function createSegment(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "campaign.manage");
  const data = segmentSchema.parse(input);
  buildFilterWhere(data.entity, data.filters);
  return prisma.$transaction(async (tx) => {
    const segment = await tx.segment.create({ data: { ...data, filters: data.filters as Prisma.InputJsonValue, organizationId: ctx.organizationId, createdById: ctx.userId } });
    await audit(tx, ctx, { action: "segment.created", entity: "segment", entityId: segment.id, next: segment });
    return segment;
  });
}

async function findSegment(db: Db, ctx: AccessContext, id: string) {
  const segment = await db.segment.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!segment) throw new AppError("NOT_FOUND", "Segment not found", 404);
  return segment;
}

export async function updateSegment(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "campaign.manage");
  const data = segmentSchema.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "segments" WHERE "id" = ${id} FOR UPDATE`;
    const before = await findSegment(tx, ctx, id);
    // A segment used by a campaign past DRAFT is frozen: its audience was reviewed and approved.
    if (await tx.campaign.count({ where: { segmentId: id, status: { in: ["PENDING_APPROVAL", "APPROVED", "SENDING"] } } })) {
      throw new AppError("SEGMENT_IN_USE", "This segment is used by a campaign awaiting approval or sending", 422);
    }
    const entity = data.entity ?? (before.entity as SegmentEntity);
    buildFilterWhere(entity, data.filters ?? filtersSchema.parse(before.filters));
    const segment = await tx.segment.update({ where: { id }, data: { ...data, filters: data.filters as Prisma.InputJsonValue | undefined } });
    await audit(tx, ctx, { action: "segment.updated", entity: "segment", entityId: id, previous: before, next: segment });
    return segment;
  });
}

export async function deleteSegment(ctx: AccessContext, id: string) {
  assertCan(ctx, "campaign.manage");
  return prisma.$transaction(async (tx) => {
    const segment = await findSegment(tx, ctx, id);
    if (await tx.campaign.count({ where: { segmentId: id } })) throw new AppError("SEGMENT_IN_USE", "Campaigns use this segment", 422);
    await tx.segment.delete({ where: { id } });
    await audit(tx, ctx, { action: "segment.deleted", entity: "segment", entityId: id, previous: segment });
    return { id };
  });
}

export async function getSegment(ctx: AccessContext, id: string) {
  assertCan(ctx, "campaign.view");
  return findSegment(prisma, ctx, id);
}

export async function listSegments(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "campaign.view");
  const q = listQuerySchema.extend({ entity: z.enum(SEGMENT_ENTITIES).optional() }).parse(query);
  const where: Prisma.SegmentWhereInput = { organizationId: ctx.organizationId, entity: q.entity, ...searchWhere(q.q, ["name"]) };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.segment.findMany({ where, include: { _count: { select: { campaigns: true } } }, ...listArgs(q, ["createdAt", "name"], "createdAt") }),
      prisma.segment.count({ where }),
    ]),
  );
}

const previewSchema = z.object({
  segmentId: z.string().min(1).optional(),
  entity: z.enum(SEGMENT_ENTITIES).optional(),
  filters: filtersSchema.optional(),
  channel: z.nativeEnum(CommunicationType),
  purpose: z.enum(["TRANSACTIONAL", "MARKETING"]).default("MARKETING"),
});

/** Preview a saved segment (`segmentId`) or unsaved filters (`entity` + `filters`). */
export async function previewSegment(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "campaign.view");
  const data = previewSchema.parse(input);
  const segment = data.segmentId
    ? await findSegment(prisma, ctx, data.segmentId)
    : data.entity
      ? { entity: data.entity, filters: data.filters ?? [] }
      : null;
  if (!segment) throw new AppError("VALIDATION_ERROR", "Give a segmentId or an entity with filters", 422);
  assertCan(ctx, VIEW_PERMISSION[segment.entity as SegmentEntity]);
  const members = await resolveAudience(prisma, ctx.organizationId, segment, data.channel, ctx);
  return breakdown(prisma, ctx.organizationId, members, data.channel, data.purpose);
}
