import { z } from "zod";
import { CommunicationType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { normalizeAddress } from "./send";

/**
 * Contact consent per (channel, address, purpose). consent.view reads, consent.manage records.
 * Rules applied at send time are in send.ts (checkConsent). Records are upserted, never deleted:
 * the latest status, source and who recorded it is kept, with history in the audit log.
 */
export const PURPOSES = ["TRANSACTIONAL", "MARKETING"] as const;
export const CONSENT_STATUSES = ["OPTED_IN", "OPTED_OUT"] as const;

const address = (channel: CommunicationType, raw: string) => {
  const normalized = normalizeAddress(channel, raw);
  if (!normalized) throw new AppError("VALIDATION_ERROR", channel === "EMAIL" ? "Invalid email address" : "Invalid phone number (include the country code)", 422);
  return normalized;
};
const recordSchema = z.object({
  channel: z.nativeEnum(CommunicationType),
  address: z.string().trim().min(3).max(320),
  purpose: z.enum(PURPOSES),
  status: z.enum(CONSENT_STATUSES),
  source: z.string().trim().max(100).nullish(),
});
const updateSchema = z.object({ status: z.enum(CONSENT_STATUSES), source: z.string().trim().max(100).nullish() }).strict();
const optOutSchema = z.object({
  channel: z.nativeEnum(CommunicationType),
  address: z.string().trim().min(3).max(320),
  purposes: z.array(z.enum(PURPOSES)).min(1).default([...PURPOSES]),
  source: z.string().trim().max(100).nullish(),
});
const listSchema = listQuerySchema.extend({
  channel: z.nativeEnum(CommunicationType).optional(),
  purpose: z.enum(PURPOSES).optional(),
  status: z.enum(CONSENT_STATUSES).optional(),
});

export async function listConsents(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "consent.view");
  const q = listSchema.parse(query);
  const where: Prisma.ContactConsentWhereInput = {
    organizationId: ctx.organizationId,
    channel: q.channel,
    purpose: q.purpose,
    status: q.status,
    ...searchWhere(q.q?.toLowerCase(), ["address"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.contactConsent.findMany({ where, ...listArgs(q, ["recordedAt", "updatedAt", "address"], "updatedAt") }),
      prisma.contactConsent.count({ where }),
    ]),
  );
}

export async function getConsent(ctx: AccessContext, id: string) {
  assertCan(ctx, "consent.view");
  const row = await prisma.contactConsent.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!row) throw new AppError("NOT_FOUND", "Consent record not found", 404);
  return row;
}

async function upsertConsent(tx: Prisma.TransactionClient, ctx: AccessContext, c: { channel: CommunicationType; address: string; purpose: string; status: string; source?: string | null }) {
  const key = { organizationId: ctx.organizationId, channel: c.channel, address: c.address, purpose: c.purpose };
  const previous = await tx.contactConsent.findUnique({ where: { organizationId_channel_address_purpose: key } });
  const fields = { status: c.status, source: c.source ?? "manual", recordedById: ctx.userId, recordedAt: new Date() };
  const row = await tx.contactConsent.upsert({
    where: { organizationId_channel_address_purpose: key },
    create: { ...key, ...fields },
    update: fields,
  });
  await audit(tx, ctx, { action: "consent.recorded", entity: "contact_consent", entityId: row.id, previous: previous ? { status: previous.status, source: previous.source } : undefined, next: { status: row.status, source: row.source } });
  return row;
}

export async function recordConsent(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "consent.manage");
  const data = recordSchema.parse(input);
  const normalized = address(data.channel, data.address);
  return prisma.$transaction((tx) => upsertConsent(tx, ctx, { ...data, address: normalized }));
}

export async function updateConsent(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "consent.manage");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const row = await tx.contactConsent.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!row) throw new AppError("NOT_FOUND", "Consent record not found", 404);
    return upsertConsent(tx, ctx, { ...row, ...data });
  });
}

/** Opt an address out of the given purposes (default: all) on one channel. */
export async function optOut(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "consent.manage");
  const data = optOutSchema.parse(input);
  const normalized = address(data.channel, data.address);
  return prisma.$transaction(async (tx) => {
    const rows = [];
    for (const purpose of data.purposes) rows.push(await upsertConsent(tx, ctx, { channel: data.channel, address: normalized, purpose, status: "OPTED_OUT", source: data.source ?? "opt_out" }));
    return rows;
  });
}
