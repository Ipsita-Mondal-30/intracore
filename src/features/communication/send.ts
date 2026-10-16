import type { CommunicationLog, CommunicationType, MessageTemplate, Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { enqueue } from "@/lib/queue";

type Db = PrismaClient | Prisma.TransactionClient;
export type Purpose = "TRANSACTIONAL" | "MARKETING";

/** Lower-cased email, or a phone as digits with country code (no "+"); null when invalid. */
export function normalizeAddress(channel: CommunicationType, raw: string): string | null {
  const value = raw.trim();
  if (channel === "EMAIL") {
    const email = value.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }
  const digits = value.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}

/**
 * Consent rules:
 * - an explicit OPTED_OUT for the purpose always blocks;
 * - MARKETING needs an explicit OPTED_IN on that channel;
 * - WhatsApp needs an explicit OPTED_IN for every business-initiated message (platform policy);
 * - TRANSACTIONAL email/SMS is allowed unless opted out.
 */
export async function checkConsent(db: Db, organizationId: string, channel: CommunicationType, address: string, purpose: Purpose) {
  const consent = await db.contactConsent.findUnique({
    where: { organizationId_channel_address_purpose: { organizationId, channel, address, purpose } },
  });
  if (consent?.status === "OPTED_OUT") return { allowed: false as const, reason: "OPTED_OUT" };
  const needsOptIn = purpose === "MARKETING" || channel === "WHATSAPP";
  if (needsOptIn && consent?.status !== "OPTED_IN") return { allowed: false as const, reason: "NO_CONSENT" };
  return { allowed: true as const };
}

/** Replace {{name}} placeholders. Every placeholder must be declared and supplied. */
export function renderTemplate(template: Pick<MessageTemplate, "body" | "subject" | "variables">, values: Record<string, string> = {}) {
  const fill = (text: string) =>
    text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
      if (!template.variables.includes(name)) throw new AppError("TEMPLATE_INVALID", `Undeclared variable {{${name}}}`, 422);
      const v = values[name];
      if (v === undefined || v === "") throw new AppError("TEMPLATE_VARIABLES", `Missing value for {{${name}}}`, 422);
      return v;
    });
  return { subject: template.subject ? fill(template.subject) : null, body: fill(template.body) };
}

/**
 * Record an outbound message and queue its delivery. Never throws for consent: a message
 * without consent is logged as BLOCKED with the reason, so audiences can be reported on.
 * Retry-safe: the same idempotencyKey returns the existing log.
 */
export async function queueMessage(
  db: Db,
  input: {
    organizationId: string;
    channel: CommunicationType;
    to: string;
    templateId: string;
    variables?: Record<string, string>;
    purpose?: Purpose;
    entityType?: string | null;
    entityId?: string | null;
    campaignId?: string | null;
    idempotencyKey: string;
    createdById?: string | null;
  },
): Promise<CommunicationLog> {
  const existing = await db.communicationLog.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) return existing;

  const template = await db.messageTemplate.findFirst({ where: { id: input.templateId, organizationId: input.organizationId } });
  if (!template || !template.isActive) throw new AppError("INVALID_REFERENCE", "Template not found or inactive", 422);
  if (template.channel !== input.channel) throw new AppError("TEMPLATE_CHANNEL", `Template is for ${template.channel}`, 422);
  const purpose: Purpose = template.category === "MARKETING" ? "MARKETING" : (input.purpose ?? "TRANSACTIONAL");
  const rendered = renderTemplate(template, input.variables);

  const address = normalizeAddress(input.channel, input.to);
  const consent = address ? await checkConsent(db, input.organizationId, input.channel, address, purpose) : { allowed: false as const, reason: "INVALID_ADDRESS" };

  const log = await db.communicationLog.create({
    data: {
      organizationId: input.organizationId,
      channel: input.channel,
      provider: "pending",
      templateId: template.id,
      campaignId: input.campaignId ?? null,
      toAddress: address ?? input.to.trim(),
      subject: rendered.subject,
      body: rendered.body,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      status: consent.allowed ? "QUEUED" : "BLOCKED",
      error: consent.allowed ? null : consent.reason,
      idempotencyKey: input.idempotencyKey,
      createdById: input.createdById ?? null,
    },
  });
  if (consent.allowed) {
    await enqueue(db, { type: "communication.deliver", key: `communication.deliver:${log.id}`, organizationId: input.organizationId, payload: { logId: log.id } });
  }
  return log;
}
