import type { WebhookEvent } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { sanitizeError } from "@/lib/sanitize";

/**
 * Queue handler "webhook.process": applies one stored WhatsApp webhook item.
 * - status → CommunicationLog (matched by provider message id), monotonic:
 *   QUEUED → SENT → DELIVERED → READ; FAILED only from QUEUED/SENT. Never moves backwards,
 *   so late or duplicate statuses are IGNORED.
 * - inbound message → CommunicationLog INBOUND/RECEIVED; "STOP"/"UNSUBSCRIBE" opts the sender
 *   out of MARKETING and TRANSACTIONAL WhatsApp.
 * A status for a message we have not recorded yet (the webhook can beat our own DB write)
 * is retried; after UNKNOWN_RETRIES attempts it is IGNORED (e.g. sent outside this system).
 *
 * Kept free of imports from send.ts/queue.ts: queue-handlers imports this module.
 */
export type WhatsAppStatus = { id: string; status: string; timestamp?: string; recipient_id?: string; errors?: { code?: number; title?: string; message?: string }[] };
export type WhatsAppMessage = { id: string; from: string; type: string; timestamp?: string; text?: { body?: string } };
export type StoredWebhookPayload =
  | { kind: "status"; phoneNumberId: string; status: WhatsAppStatus }
  | { kind: "message"; phoneNumberId: string; message: WhatsAppMessage };

const PROVIDER = "whatsapp_cloud";
const UNKNOWN_RETRIES = 3;
const STATUS_MAP: Record<string, "SENT" | "DELIVERED" | "READ" | "FAILED"> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
/** statuses a log may be in for each target status to apply */
const ALLOWED_FROM = { SENT: ["QUEUED"], DELIVERED: ["QUEUED", "SENT"], READ: ["QUEUED", "SENT", "DELIVERED"], FAILED: ["QUEUED", "SENT"] };
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE"]);

class Retry extends Error {}

async function applyStatus(event: WebhookEvent, s: WhatsAppStatus, attempt: number) {
  const target = STATUS_MAP[s.status];
  if (!target) return { status: "IGNORED", note: `Unknown status ${s.status}` };
  const log = await prisma.communicationLog.findFirst({ where: { organizationId: event.organizationId!, provider: PROVIDER, providerMessageId: s.id }, select: { id: true } });
  if (!log) {
    if (attempt < UNKNOWN_RETRIES) throw new Retry(`No message with provider id ${s.id} yet`);
    return { status: "IGNORED", note: "Unknown message" };
  }
  const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
  const error = target === "FAILED" ? sanitizeError(s.errors?.map((e) => `${e.code ?? ""} ${e.title ?? e.message ?? ""}`.trim()).join("; ") || "Failed") : undefined;
  const { count } = await prisma.communicationLog.updateMany({
    where: { id: log.id, status: { in: ALLOWED_FROM[target] } },
    data: {
      status: target,
      ...(target === "SENT" ? { sentAt: at } : target === "DELIVERED" ? { deliveredAt: at } : target === "READ" ? { readAt: at } : { failedAt: at, error }),
    },
  });
  return count ? { status: "PROCESSED", note: null } : { status: "IGNORED", note: `Stale status ${target}` };
}

async function applyInbound(event: WebhookEvent, phoneNumberId: string, m: WhatsAppMessage) {
  const organizationId = event.organizationId!;
  const text = m.text?.body ?? `[${m.type}]`;
  await prisma.communicationLog.createMany({
    data: [{
      organizationId,
      channel: "WHATSAPP",
      direction: "INBOUND",
      provider: PROVIDER,
      providerMessageId: m.id,
      fromAddress: m.from,
      toAddress: phoneNumberId,
      body: text,
      status: "RECEIVED",
      createdAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : undefined,
    }],
    skipDuplicates: true,
  });
  const address = m.from.replace(/\D/g, "");
  if (m.type === "text" && STOP_WORDS.has(text.trim().toUpperCase()) && address) {
    for (const purpose of ["MARKETING", "TRANSACTIONAL"]) {
      await prisma.contactConsent.upsert({
        where: { organizationId_channel_address_purpose: { organizationId, channel: "WHATSAPP", address, purpose } },
        create: { organizationId, channel: "WHATSAPP", address, purpose, status: "OPTED_OUT", source: "whatsapp_stop" },
        update: { status: "OPTED_OUT", source: "whatsapp_stop", recordedById: null, recordedAt: new Date() },
      });
    }
    return { status: "PROCESSED", note: "Opted out" };
  }
  return { status: "PROCESSED", note: null };
}

export async function processWebhookEvent(payload: { eventId: string }): Promise<unknown> {
  const event = await prisma.webhookEvent.findUnique({ where: { id: payload.eventId } });
  if (!event || event.status === "PROCESSED" || event.status === "IGNORED") return { skipped: event?.status ?? "NOT_FOUND" };
  const attempt = event.attempts + 1;
  const body = event.payload as StoredWebhookPayload;
  try {
    if (!event.organizationId || event.provider !== PROVIDER) throw new Error("Unsupported webhook event");
    const result = body.kind === "status" ? await applyStatus(event, body.status, attempt) : await applyInbound(event, body.phoneNumberId, body.message);
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: result.status, error: result.note, attempts: attempt, processedAt: new Date() } });
    return result;
  } catch (error) {
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: error instanceof Retry ? "RECEIVED" : "FAILED", error: sanitizeError(error), attempts: attempt } });
    throw error;
  }
}
