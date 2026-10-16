import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { enqueue } from "@/lib/queue";
import { sanitizeError } from "@/lib/sanitize";
import { readSecrets } from "@/features/integrations/service";
import type { StoredWebhookPayload, WhatsAppMessage, WhatsAppStatus } from "@/features/integrations/webhooks";

/**
 * WhatsApp Cloud API webhook for one org integration (Meta callback URL:
 * <site>/api/webhooks/whatsapp/<integrationId>).
 * GET: Meta's verification handshake with the integration's verify token.
 * POST: X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret) is required.
 * Each status/message is stored once as a WebhookEvent (provider event id dedupe) and
 * processed by the queue ("webhook.process"), so the response is fast and retries are no-ops.
 */
type P = { params: Promise<{ integrationId: string }> };

const loadIntegration = (id: string) => prisma.integration.findFirst({ where: { id, provider: "whatsapp_cloud" } });

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request, { params }: P) {
  const { integrationId } = await params;
  const url = new URL(request.url);
  const integration = await loadIntegration(integrationId);
  const verifyToken = readSecrets(integration).verifyToken;
  const given = url.searchParams.get("hub.verify_token") ?? "";
  if (url.searchParams.get("hub.mode") !== "subscribe" || !verifyToken || !safeEqual(Buffer.from(given), Buffer.from(verifyToken))) {
    return new NextResponse("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
  }
  return new NextResponse(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
}

type Change = { field?: string; value?: { metadata?: { phone_number_id?: string }; statuses?: WhatsAppStatus[]; messages?: WhatsAppMessage[] } };

export async function POST(request: Request, { params }: P) {
  try {
    const { integrationId } = await params;
    const raw = await request.text();
    const integration = await loadIntegration(integrationId);
    const appSecret = readSecrets(integration).appSecret;
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    const expected = appSecret ? createHmac("sha256", appSecret).update(raw).digest() : null;
    // Same answer for unknown integrations and bad signatures.
    if (!integration || !expected || !signature.startsWith("sha256=") || !safeEqual(Buffer.from(signature.slice(7), "hex"), expected)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: { entry?: { changes?: Change[] }[] };
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    const phoneNumberId = (integration.metadata as Record<string, string> | null)?.phoneNumberId;
    const items: { externalId: string; payload: StoredWebhookPayload }[] = [];
    for (const change of body.entry?.flatMap((e) => e.changes ?? []) ?? []) {
      const value = change.value;
      const number = value?.metadata?.phone_number_id;
      if (!value || !number || (phoneNumberId && number !== phoneNumberId)) continue; // another number on the same app
      for (const s of value.statuses ?? []) if (s?.id && s.status) items.push({ externalId: `${s.id}:${s.status}`, payload: { kind: "status", phoneNumberId: number, status: s } });
      for (const m of value.messages ?? []) if (m?.id && m.from) items.push({ externalId: m.id, payload: { kind: "message", phoneNumberId: number, message: m } });
    }

    if (items.length) {
      await prisma.$transaction(async (tx) => {
        const created = await tx.webhookEvent.createManyAndReturn({
          data: items.map((i) => ({ id: randomUUID(), organizationId: integration.organizationId, provider: "whatsapp_cloud", externalId: i.externalId, payload: i.payload })),
          skipDuplicates: true,
          select: { id: true },
        });
        for (const e of created) {
          await enqueue(tx, { type: "webhook.process", key: `webhook.process:${e.id}`, organizationId: integration.organizationId, payload: { eventId: e.id } });
        }
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[whatsapp webhook]", sanitizeError(error));
    return NextResponse.json({ ok: false, error: "Webhook failed" }, { status: 500 });
  }
}
