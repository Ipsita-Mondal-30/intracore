import { z } from "zod";
import { CommunicationDirection, CommunicationType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { resolveEntity } from "@/lib/entities";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { queueMessage } from "./send";

/**
 * Communication log (communication.view) and one-off transactional sends (communication.send).
 * `simulated: true` marks messages handled by a mock provider: they were never sent anywhere.
 */
export const LOG_STATUSES = ["QUEUED", "SENT", "DELIVERED", "READ", "FAILED", "BLOCKED", "RECEIVED"] as const;

const listSchema = listQuerySchema.extend({
  channel: z.nativeEnum(CommunicationType).optional(),
  direction: z.nativeEnum(CommunicationDirection).optional(),
  status: z.enum(LOG_STATUSES).optional(),
  simulated: z.enum(["true", "false"]).optional(),
  campaignId: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
});
const sendSchema = z.object({
  channel: z.nativeEnum(CommunicationType),
  to: z.string().trim().min(3).max(320),
  templateId: z.string().min(1),
  variables: z.record(z.string().max(1000)).default({}),
  entityType: z.string().min(1).max(50).nullish(),
  entityId: z.string().min(1).max(100).nullish(),
});

export async function listMessages(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "communication.view");
  const q = listSchema.parse(query);
  const where: Prisma.CommunicationLogWhereInput = {
    organizationId: ctx.organizationId,
    channel: q.channel,
    direction: q.direction,
    status: q.status,
    simulated: q.simulated ? q.simulated === "true" : undefined,
    campaignId: q.campaignId,
    entityType: q.entityType,
    entityId: q.entityId,
    ...searchWhere(q.q, ["toAddress", "fromAddress", "subject"]),
  };
  return paginate(q, () =>
    Promise.all([
      prisma.communicationLog.findMany({
        where,
        include: { template: { select: { id: true, name: true } } },
        ...listArgs(q, ["createdAt", "sentAt", "status", "channel"], "createdAt"),
      }),
      prisma.communicationLog.count({ where }),
    ]),
  );
}

export async function getMessage(ctx: AccessContext, id: string) {
  assertCan(ctx, "communication.view");
  const row = await prisma.communicationLog.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { template: { select: { id: true, name: true, providerTemplateName: true } } },
  });
  if (!row) throw new AppError("NOT_FOUND", "Message not found", 404);
  return row;
}

/** Queue a one-off transactional message. Marketing goes through campaigns (approval + consent). */
export async function sendMessage(ctx: AccessContext, input: unknown, idempotencyKey: string | null) {
  assertCan(ctx, "communication.send");
  if (!idempotencyKey) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", 400);
  const data = sendSchema.parse(input);
  if (Boolean(data.entityType) !== Boolean(data.entityId)) throw new AppError("VALIDATION_ERROR", "entityType and entityId go together", 422);
  if (data.entityType && data.entityId) await resolveEntity(ctx, data.entityType, data.entityId);
  const template = await prisma.messageTemplate.findFirst({ where: { id: data.templateId, organizationId: ctx.organizationId }, select: { category: true } });
  if (template?.category === "MARKETING") throw new AppError("TEMPLATE_CATEGORY", "Marketing templates are sent through campaigns", 422);
  return prisma.$transaction(async (tx) => {
    const log = await queueMessage(tx, {
      organizationId: ctx.organizationId,
      channel: data.channel,
      to: data.to,
      templateId: data.templateId,
      variables: data.variables,
      purpose: "TRANSACTIONAL",
      entityType: data.entityType ?? null,
      entityId: data.entityId ?? null,
      idempotencyKey: `api:${ctx.userId}:${idempotencyKey}`,
      createdById: ctx.userId,
    });
    await audit(tx, ctx, { action: "communication.queued", entity: "communication_log", entityId: log.id, next: { channel: log.channel, to: log.toAddress, status: log.status, templateId: log.templateId } });
    return log;
  });
}
