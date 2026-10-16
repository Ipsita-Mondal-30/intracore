import { z } from "zod";
import { CommunicationType, type MessageTemplate, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";

/**
 * Message templates (communication.administer to write, communication.view to read).
 * Every {{placeholder}} in subject/body must be declared in `variables`; email templates need a
 * subject; WhatsApp templates need the provider-approved template name (Meta sends the approved
 * text, with our variables as its body parameters in declared order). Templates are never
 * deleted (logs reference them): deactivate instead. Inactive templates cannot be sent.
 */
export const TEMPLATE_CATEGORIES = ["TRANSACTIONAL", "MARKETING"] as const;

const variableName = z.string().trim().regex(/^[a-zA-Z0-9_]+$/, "Variable names may use letters, digits and _");
const variables = z
  .union([z.array(variableName), z.string().transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean)).pipe(z.array(variableName))])
  .refine((v) => new Set(v).size === v.length, "Variables must be unique");
const fields = {
  name: z.string().trim().min(1).max(100),
  language: z.string().trim().min(2).max(10).default("en"),
  category: z.enum(TEMPLATE_CATEGORIES).default("TRANSACTIONAL"),
  subject: z.string().trim().max(300).nullish(),
  body: z.string().trim().min(1).max(4096),
  variables: variables.default([]),
  providerTemplateName: z.string().trim().max(512).nullish(),
  isActive: z.boolean().default(true),
};
const createSchema = z.object({ channel: z.nativeEnum(CommunicationType), ...fields });
const updateSchema = z.object(fields).partial().strict();
const listSchema = listQuerySchema.extend({
  channel: z.nativeEnum(CommunicationType).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  active: z.enum(["true", "false"]).optional(),
});

function validate(t: Pick<MessageTemplate, "channel" | "subject" | "body" | "variables" | "providerTemplateName">) {
  const used = [...`${t.subject ?? ""} ${t.body}`.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
  const undeclared = used.filter((v) => !t.variables.includes(v));
  if (undeclared.length) throw new AppError("TEMPLATE_INVALID", `Undeclared placeholders: ${[...new Set(undeclared)].join(", ")}`, 422);
  if (t.channel === "EMAIL" && !t.subject) throw new AppError("TEMPLATE_INVALID", "Email templates need a subject", 422);
  if (t.channel === "WHATSAPP" && !t.providerTemplateName) {
    throw new AppError("TEMPLATE_INVALID", "WhatsApp templates need the approved provider template name", 422);
  }
}

async function findTemplate(db: Prisma.TransactionClient | typeof prisma, ctx: AccessContext, id: string) {
  const row = await db.messageTemplate.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!row) throw new AppError("NOT_FOUND", "Template not found", 404);
  return row;
}

export async function listTemplates(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "communication.view");
  const q = listSchema.parse(query);
  const where: Prisma.MessageTemplateWhereInput = {
    organizationId: ctx.organizationId,
    channel: q.channel,
    category: q.category,
    isActive: q.active ? q.active === "true" : undefined,
    ...searchWhere(q.q, ["name", "providerTemplateName"]),
  };
  return paginate(q, () =>
    Promise.all([
      prisma.messageTemplate.findMany({ where, ...listArgs(q, ["createdAt", "name", "channel", "updatedAt"], "name") }),
      prisma.messageTemplate.count({ where }),
    ]),
  );
}

export async function getTemplate(ctx: AccessContext, id: string) {
  assertCan(ctx, "communication.view");
  return findTemplate(prisma, ctx, id);
}

export async function createTemplate(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "communication.administer");
  const data = createSchema.parse(input);
  const row = { ...data, subject: data.subject ?? null, providerTemplateName: data.providerTemplateName ?? null };
  validate(row);
  return prisma.$transaction(async (tx) => {
    const created = await tx.messageTemplate.create({ data: { ...row, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "message_template.created", entity: "message_template", entityId: created.id, next: created });
    return created;
  });
}

export async function updateTemplate(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "communication.administer");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "message_templates" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const current = await findTemplate(tx, ctx, id);
    validate({ ...current, ...data, subject: data.subject === undefined ? current.subject : data.subject, providerTemplateName: data.providerTemplateName === undefined ? current.providerTemplateName : data.providerTemplateName });
    const updated = await tx.messageTemplate.update({ where: { id }, data });
    const diff = changes(current as unknown as Record<string, unknown>, data as Record<string, unknown>);
    if (diff.changed) await audit(tx, ctx, { action: "message_template.updated", entity: "message_template", entityId: id, previous: diff.previous, next: diff.next });
    return updated;
  });
}
