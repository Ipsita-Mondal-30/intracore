import { prisma } from "@/lib/db/prisma";
import { buildAccessContext } from "@/lib/access";
import { enqueue } from "@/lib/queue";
import { queueMessage, type Purpose } from "@/features/communication/send";
import { resolveAudience } from "@/features/marketing/segments";

const BATCH = 100;
/** Stay well inside the queue's 30 s handler timeout; the rest continues in a follow-up job. */
const TIME_BUDGET_MS = 20_000;

/**
 * "campaign.dispatch" handler. Idempotent and resumable:
 * 1. materializes recipients (one per normalized address, deduplicated across records) with
 *    createMany skipDuplicates — re-running only adds records that newly match;
 * 2. queues each PENDING recipient in its own transaction, under a row lock, through
 *    `queueMessage` with idempotency key `campaign:<id>:<address>`, so a crash or an overlapping
 *    run can never create a second message for the same address;
 * 3. completes the campaign when nothing is PENDING.
 * A cancelled campaign stops between recipients. Lead audiences use the submitter's lead visibility
 * (the person whose audience was validated at submit).
 */
export async function dispatchCampaign(payload: { campaignId: string }): Promise<unknown> {
  const started = Date.now();
  const campaign = await prisma.campaign.findUnique({ where: { id: payload.campaignId }, include: { segment: true } });
  if (!campaign || campaign.status !== "SENDING") return { campaignId: payload.campaignId, skipped: campaign?.status ?? "NOT_FOUND" };
  const { id, organizationId, channel } = campaign;

  const reviewer = campaign.submittedById ?? campaign.createdById;
  const viewer = campaign.segment.entity === "LEAD" && reviewer ? await buildAccessContext(reviewer, organizationId) : undefined;
  const audience = await resolveAudience(prisma, organizationId, campaign.segment, channel, viewer);
  const seen = new Set<string>();
  const rows = audience.flatMap((m) => {
    const address = m.address ?? m.raw.toLowerCase();
    if (!address || seen.has(address)) return [];
    seen.add(address);
    return [{ organizationId, campaignId: id, address, name: m.name, customerId: m.customerId ?? null, contactId: m.contactId ?? null, leadId: m.leadId ?? null }];
  });
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.campaignRecipient.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
  }

  let queued = 0;
  let skipped = 0;
  for (;;) {
    const batch = await prisma.campaignRecipient.findMany({ where: { campaignId: id, status: "PENDING" }, orderBy: { id: "asc" }, take: BATCH });
    if (!batch.length) break;
    for (const r of batch) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        const done = await prisma.campaignRecipient.count({ where: { campaignId: id, status: { not: "PENDING" } } });
        await enqueue(prisma, { type: "campaign.dispatch", key: `campaign.dispatch:${id}:after:${done}`, organizationId, payload: { campaignId: id } });
        return { campaignId: id, queued, skipped, continued: true };
      }
      const outcome = await prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "campaign_recipients" WHERE "id" = ${r.id} FOR UPDATE`;
        if (row?.status !== "PENDING") return "done";
        const current = await tx.campaign.findUnique({ where: { id }, select: { status: true } });
        if (current?.status !== "SENDING") return "stopped";
        const log = await queueMessage(tx, {
          organizationId,
          channel,
          to: r.address,
          templateId: campaign.templateId,
          variables: { name: r.name ?? "Customer" },
          purpose: campaign.purpose as Purpose,
          entityType: r.leadId ? "lead" : r.contactId ? "contact" : "customer",
          entityId: r.leadId ?? r.contactId ?? r.customerId,
          campaignId: id,
          idempotencyKey: `campaign:${id}:${r.address}`,
          createdById: campaign.createdById,
        });
        const blocked = log.status === "BLOCKED";
        await tx.campaignRecipient.update({
          where: { id: r.id },
          data: blocked ? { status: "SKIPPED", skipReason: log.error, communicationLogId: log.id } : { status: "QUEUED", communicationLogId: log.id },
        });
        return blocked ? "skipped" : "queued";
      });
      if (outcome === "stopped") return { campaignId: id, queued, skipped, stopped: true };
      if (outcome === "queued") queued++;
      if (outcome === "skipped") skipped++;
    }
  }
  await prisma.campaign.updateMany({ where: { id, status: "SENDING" }, data: { status: "COMPLETED", completedAt: new Date() } });
  return { campaignId: id, queued, skipped, completed: true };
}
