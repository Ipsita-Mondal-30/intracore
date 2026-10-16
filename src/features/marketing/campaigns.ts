import { z } from "zod";
import { CommunicationType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { enqueue } from "@/lib/queue";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import type { Purpose } from "@/features/communication/send";
import { breakdown, resolveAudience } from "@/features/marketing/segments";

/**
 * Campaigns: DRAFT → PENDING_APPROVAL → APPROVED → SENDING → COMPLETED.
 *   submit   DRAFT → PENDING_APPROVAL, only when the segment has ≥ 1 eligible recipient (else 422 AUDIENCE_EMPTY)
 *   approve  PENDING_APPROVAL → APPROVED (campaign.approve; never by the creator or submitter → 403)
 *   reject   PENDING_APPROVAL → DRAFT (reason kept in the audit trail)
 *   schedule APPROVED: set/clear `scheduledAt` (future); the campaign-scheduler job starts it when due
 *   send     APPROVED → SENDING now and queues "campaign.dispatch"
 *   cancel   any state before COMPLETED → CANCELLED; recipients not yet queued are SKIPPED (CANCELLED)
 * Editing is allowed only in DRAFT. Sending never depends on a provider being configured: messages
 * the provider can't take fail with their reason and the campaign still completes and reports.
 */

export const CAMPAIGN_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENDING", "COMPLETED", "CANCELLED"] as const;
/** Template placeholders a campaign can fill per recipient. */
export const CAMPAIGN_VARIABLES = ["name"] as const;

const future = z.coerce.date().refine((d) => d.getTime() > Date.now(), "Schedule a time in the future");
const campaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: z.nativeEnum(CommunicationType),
  templateId: z.string().min(1),
  segmentId: z.string().min(1),
  purpose: z.enum(["TRANSACTIONAL", "MARKETING"]).optional(),
  scheduledAt: future.nullish(),
});

type Tx = Prisma.TransactionClient;

async function validateRefs(tx: Tx, ctx: AccessContext, data: { channel: CommunicationType; templateId: string; segmentId: string; purpose?: Purpose }) {
  const [template, segment] = await Promise.all([
    tx.messageTemplate.findFirst({ where: { id: data.templateId, organizationId: ctx.organizationId, isActive: true } }),
    tx.segment.findFirst({ where: { id: data.segmentId, organizationId: ctx.organizationId } }),
  ]);
  if (!template) throw new AppError("INVALID_REFERENCE", "Template not found or inactive", 422);
  if (!segment) throw new AppError("INVALID_REFERENCE", "Segment not found", 422);
  if (template.channel !== data.channel) throw new AppError("TEMPLATE_CHANNEL", `Template is for ${template.channel}, campaign is ${data.channel}`, 422);
  const extra = template.variables.filter((v) => !(CAMPAIGN_VARIABLES as readonly string[]).includes(v));
  if (extra.length) throw new AppError("TEMPLATE_VARIABLES", `Campaigns can only fill {{${CAMPAIGN_VARIABLES.join("}}, {{")}}}; template uses ${extra.join(", ")}`, 422);
  if (template.category === "MARKETING" && data.purpose === "TRANSACTIONAL") {
    throw new AppError("VALIDATION_ERROR", "A marketing template can only be sent with purpose MARKETING", 422);
  }
  return (data.purpose ?? (template.category === "MARKETING" ? "MARKETING" : "TRANSACTIONAL")) as Purpose;
}

const include = {
  template: { select: { id: true, name: true, channel: true, category: true, subject: true, body: true } },
  segment: { select: { id: true, name: true, entity: true } },
} satisfies Prisma.CampaignInclude;

export async function createCampaign(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "campaign.manage");
  const data = campaignSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const purpose = await validateRefs(tx, ctx, data);
    const campaign = await tx.campaign.create({
      data: { ...data, purpose, scheduledAt: data.scheduledAt ?? null, organizationId: ctx.organizationId, createdById: ctx.userId },
      include,
    });
    await audit(tx, ctx, { action: "campaign.created", entity: "campaign", entityId: campaign.id, next: campaign });
    return campaign;
  });
}

async function lockCampaign(tx: Tx, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "campaigns" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const campaign = await tx.campaign.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!campaign) throw new AppError("NOT_FOUND", "Campaign not found", 404);
  return campaign;
}

export async function updateCampaign(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "campaign.manage");
  const data = campaignSchema.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockCampaign(tx, ctx, id);
    if (before.status !== "DRAFT") throw new AppError("INVALID_STATE", `Only draft campaigns can be edited (this one is ${before.status})`, 422);
    const merged = {
      channel: data.channel ?? before.channel,
      templateId: data.templateId ?? before.templateId,
      segmentId: data.segmentId ?? before.segmentId,
      // a new template re-derives the purpose unless one is given
      purpose: (data.purpose ?? (data.templateId ? undefined : before.purpose)) as Purpose | undefined,
    };
    const purpose = await validateRefs(tx, ctx, merged);
    const campaign = await tx.campaign.update({ where: { id }, data: { ...data, purpose }, include });
    await audit(tx, ctx, { action: "campaign.updated", entity: "campaign", entityId: id, previous: before, next: campaign });
    return campaign;
  });
}

/** Audience counts for a campaign, evaluated now with `viewer`'s lead visibility. */
export async function campaignAudience(db: Tx | typeof prisma, campaign: { organizationId: string; channel: CommunicationType; purpose: string; segmentId: string }, viewer: AccessContext) {
  const segment = await db.segment.findFirstOrThrow({ where: { id: campaign.segmentId, organizationId: campaign.organizationId } });
  const members = await resolveAudience(db, campaign.organizationId, segment, campaign.channel, viewer);
  return breakdown(db, campaign.organizationId, members, campaign.channel, campaign.purpose as Purpose);
}

const actionSchemas = {
  submit: z.object({}),
  approve: z.object({}),
  reject: z.object({ reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000) }),
  schedule: z.object({ scheduledAt: future.nullable() }),
  send: z.object({}),
  cancel: z.object({ reason: z.string().trim().max(1000).optional() }),
};
export type CampaignAction = keyof typeof actionSchemas;
export const CAMPAIGN_ACTIONS = Object.keys(actionSchemas) as CampaignAction[];

export async function transitionCampaign(ctx: AccessContext, id: string, action: CampaignAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  const body = schema.parse(input ?? {}) as { reason?: string; scheduledAt?: Date | null };
  assertCan(ctx, action === "approve" || action === "reject" ? "campaign.approve" : "campaign.manage");

  return prisma.$transaction(async (tx) => {
    const c = await lockCampaign(tx, ctx, id);
    const expect = (...allowed: string[]) => {
      if (!allowed.includes(c.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a campaign that is ${c.status}`, 422);
    };
    const now = new Date();
    let data: Prisma.CampaignUncheckedUpdateInput;
    let audience: unknown;
    switch (action) {
      case "submit": {
        expect("DRAFT");
        const counts = await campaignAudience(tx, c, ctx);
        if (counts.eligible < 1) {
          const b = counts.blocked;
          throw new AppError("AUDIENCE_EMPTY", `No recipient can receive this campaign (${counts.total} matched; no consent ${b.NO_CONSENT}, opted out ${b.OPTED_OUT}, no valid address ${b.INVALID_ADDRESS})`, 422, counts);
        }
        audience = { ...counts, sample: undefined };
        data = { status: "PENDING_APPROVAL", submittedById: ctx.userId };
        break;
      }
      case "approve":
        expect("PENDING_APPROVAL");
        if (c.createdById === ctx.userId || c.submittedById === ctx.userId) {
          throw new AppError("FORBIDDEN", "A campaign must be approved by someone other than its creator and submitter", 403);
        }
        data = { status: "APPROVED", approvedById: ctx.userId, approvedAt: now };
        break;
      case "reject":
        expect("PENDING_APPROVAL");
        data = { status: "DRAFT", submittedById: null };
        break;
      case "schedule":
        expect("APPROVED");
        data = { scheduledAt: body.scheduledAt ?? null };
        break;
      case "send":
        expect("APPROVED");
        data = { status: "SENDING", startedAt: now, scheduledAt: now };
        await enqueue(tx, { type: "campaign.dispatch", key: `campaign.dispatch:${id}`, organizationId: c.organizationId, payload: { campaignId: id } });
        break;
      case "cancel":
        expect("DRAFT", "PENDING_APPROVAL", "APPROVED", "SENDING");
        data = { status: "CANCELLED", completedAt: now };
        // The dispatcher re-checks status between recipients; whatever is still PENDING is never queued.
        await tx.campaignRecipient.updateMany({ where: { campaignId: id, status: "PENDING" }, data: { status: "SKIPPED", skipReason: "CANCELLED" } });
        break;
    }
    const updated = await tx.campaign.update({ where: { id }, data: data!, include });
    await audit(tx, ctx, {
      action: `campaign.${action}`,
      entity: "campaign",
      entityId: id,
      previous: { status: c.status, scheduledAt: c.scheduledAt },
      next: { status: updated.status, scheduledAt: updated.scheduledAt, reason: body.reason, audience },
    });
    return updated;
  });
}

/**
 * Scheduler job: claims APPROVED campaigns whose time has come (conditional update, so
 * overlapping runs start each campaign once) and queues their dispatch.
 */
export async function startDueCampaigns(now = new Date()) {
  const due = await prisma.campaign.findMany({ where: { status: "APPROVED", scheduledAt: { lte: now } }, select: { id: true, organizationId: true } });
  let started = 0;
  for (const c of due) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.campaign.updateMany({ where: { id: c.id, status: "APPROVED", scheduledAt: { lte: now } }, data: { status: "SENDING", startedAt: now } });
      if (!claimed.count) return;
      await enqueue(tx, { type: "campaign.dispatch", key: `campaign.dispatch:${c.id}`, organizationId: c.organizationId, payload: { campaignId: c.id } });
      started++;
    });
  }
  return { due: due.length, started };
}

export async function listCampaigns(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "campaign.view");
  const q = listQuerySchema.extend({ status: z.enum(CAMPAIGN_STATUSES).optional(), channel: z.nativeEnum(CommunicationType).optional() }).parse(query);
  const where: Prisma.CampaignWhereInput = { organizationId: ctx.organizationId, status: q.status, channel: q.channel, ...searchWhere(q.q, ["name"]) };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.campaign.findMany({ where, include: { ...include, _count: { select: { recipients: true } } }, ...listArgs(q, ["createdAt", "name", "scheduledAt"], "createdAt") }),
      prisma.campaign.count({ where }),
    ]),
  );
}

export async function getCampaign(ctx: AccessContext, id: string) {
  assertCan(ctx, "campaign.view");
  const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: ctx.organizationId }, include });
  if (!campaign) throw new AppError("NOT_FOUND", "Campaign not found", 404);
  return { ...campaign, metrics: await campaignMetrics(campaign.id) };
}

export async function listCampaignRecipients(ctx: AccessContext, id: string, query: unknown) {
  assertCan(ctx, "campaign.view");
  const q = listQuerySchema.extend({ status: z.string().max(20).optional() }).parse(query);
  if (!(await prisma.campaign.count({ where: { id, organizationId: ctx.organizationId } }))) throw new AppError("NOT_FOUND", "Campaign not found", 404);
  const where: Prisma.CampaignRecipientWhereInput = { campaignId: id, status: q.status, ...searchWhere(q.q, ["address", "name"]) };
  const page = await paginate(q, () =>
    prisma.$transaction([prisma.campaignRecipient.findMany({ where, ...listArgs(q, ["createdAt", "address"], "createdAt") }), prisma.campaignRecipient.count({ where })]),
  );
  // Delivery state lives on the communication log, which the delivery worker updates.
  const logs = await prisma.communicationLog.findMany({
    where: { id: { in: page.items.flatMap((r) => (r.communicationLogId ? [r.communicationLogId] : [])) } },
    select: { id: true, status: true, simulated: true, error: true, sentAt: true, deliveredAt: true },
  });
  const byId = new Map(logs.map((l) => [l.id, l]));
  return { ...page, items: page.items.map((r) => ({ ...r, log: r.communicationLogId ? byId.get(r.communicationLogId) ?? null : null })) };
}

/**
 * Campaign metrics. Real counts come only from logs with `simulated = false`; messages handled
 * by the mock provider are reported under `simulated` and never count as sent or delivered.
 *   sent      = real logs that reached SENT, DELIVERED or READ
 *   delivered = real logs DELIVERED or READ; read = real READ
 *   deliveryRate = delivered / sent (null when nothing was really sent)
 */
export async function campaignMetrics(campaignId: string) {
  const [recipients, logs] = await Promise.all([
    prisma.campaignRecipient.groupBy({ by: ["status", "skipReason"], where: { campaignId }, _count: { _all: true } }),
    prisma.communicationLog.groupBy({ by: ["status", "simulated", "error"], where: { campaignId }, _count: { _all: true } }),
  ]);
  const skippedByReason: Record<string, number> = {};
  let targeted = 0;
  let pending = 0;
  for (const r of recipients) {
    targeted += r._count._all;
    if (r.status === "PENDING") pending += r._count._all;
    if (r.status === "SKIPPED") skippedByReason[r.skipReason ?? "UNKNOWN"] = (skippedByReason[r.skipReason ?? "UNKNOWN"] ?? 0) + r._count._all;
  }
  const empty = () => ({ queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 });
  const real = empty();
  const simulated = { ...empty(), total: 0 };
  const failedByReason: Record<string, number> = {};
  for (const l of logs) {
    const n = l._count._all;
    const into = l.simulated ? simulated : real;
    if (l.simulated) simulated.total += n;
    if (l.status === "QUEUED") into.queued += n;
    if (["SENT", "DELIVERED", "READ"].includes(l.status)) into.sent += n;
    if (["DELIVERED", "READ"].includes(l.status)) into.delivered += n;
    if (l.status === "READ") into.read += n;
    if (l.status === "FAILED") {
      into.failed += n;
      // errors read "CODE: detail" (e.g. "NOT_CONFIGURED: no enabled EMAIL integration")
      const reason = /^[A-Z][A-Z0-9_]+/.exec(l.error ?? "")?.[0] ?? "ERROR";
      if (!l.simulated) failedByReason[reason] = (failedByReason[reason] ?? 0) + n;
    }
  }
  return {
    targeted,
    pending,
    skipped: Object.values(skippedByReason).reduce((a, b) => a + b, 0),
    skippedByReason,
    ...real,
    failedByReason,
    deliveryRate: real.sent ? Math.round((real.delivered / real.sent) * 10000) / 10000 : null,
    simulated,
  };
}
