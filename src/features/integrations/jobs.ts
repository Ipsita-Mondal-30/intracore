import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { enqueue } from "@/lib/queue";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";

/**
 * Failed-job visibility and controlled replay (job.view / job.replay).
 * Background jobs and webhook events are shown only for the caller's organization; rows
 * without an organization (platform jobs) are never shown. Job runs (scheduler history) are
 * platform-wide, so only name/status/timing are returned — never their result or error text.
 */
const JOB_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "DEAD", "CANCELLED"] as const;
const EVENT_STATUSES = ["RECEIVED", "PROCESSED", "IGNORED", "FAILED"] as const;

const jobList = listQuerySchema.extend({ status: z.enum(JOB_STATUSES).optional(), type: z.string().max(100).optional() });
const eventList = listQuerySchema.extend({ status: z.enum(EVENT_STATUSES).optional(), provider: z.string().max(50).optional() });
const runList = listQuerySchema.extend({ name: z.string().max(100).optional(), status: z.enum(["RUNNING", "SUCCEEDED", "FAILED"]).optional() });

const jobSelect = {
  id: true, type: true, key: true, status: true, attempts: true, maxAttempts: true, runAt: true,
  lastError: true, finishedAt: true, createdAt: true, updatedAt: true,
} satisfies Prisma.BackgroundJobSelect;

export async function listBackgroundJobs(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "job.view");
  const q = jobList.parse(query);
  const where: Prisma.BackgroundJobWhereInput = { organizationId: ctx.organizationId, status: q.status, type: q.type };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.backgroundJob.findMany({ where, select: jobSelect, ...listArgs(q, ["createdAt", "updatedAt", "runAt"], "updatedAt") }),
      prisma.backgroundJob.count({ where }),
    ]),
  );
}

export async function getBackgroundJob(ctx: AccessContext, id: string) {
  assertCan(ctx, "job.view");
  const row = await prisma.backgroundJob.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { ...jobSelect, result: true } });
  if (!row) throw new AppError("NOT_FOUND", "Job not found", 404);
  return row;
}

/** DEAD → PENDING with attempts reset. A delivery job also re-queues its FAILED message. */
export async function replayBackgroundJob(ctx: AccessContext, id: string) {
  assertCan(ctx, "job.replay");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "background_jobs" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const job = await tx.backgroundJob.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!job) throw new AppError("NOT_FOUND", "Job not found", 404);
    if (job.status !== "DEAD") throw new AppError("INVALID_STATE", `Only DEAD jobs can be replayed (job is ${job.status})`, 422);
    const updated = await tx.backgroundJob.update({
      where: { id },
      data: { status: "PENDING", attempts: 0, runAt: new Date(), lockedAt: null, finishedAt: null },
      select: jobSelect,
    });
    const logId = (job.payload as { logId?: string }).logId;
    if (job.type === "communication.deliver" && logId) {
      await tx.communicationLog.updateMany({ where: { id: logId, organizationId: ctx.organizationId, status: "FAILED" }, data: { status: "QUEUED", error: null, failedAt: null } });
    }
    await audit(tx, ctx, { action: "background_job.replayed", entity: "background_job", entityId: id, previous: { status: job.status, attempts: job.attempts, lastError: job.lastError }, next: { status: "PENDING" } });
    return updated;
  });
}

export async function listWebhookEvents(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "job.view");
  const q = eventList.parse(query);
  const where: Prisma.WebhookEventWhereInput = { organizationId: ctx.organizationId, status: q.status, provider: q.provider };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.webhookEvent.findMany({
        where,
        select: { id: true, provider: true, externalId: true, status: true, error: true, attempts: true, receivedAt: true, processedAt: true },
        ...listArgs(q, ["receivedAt", "processedAt"], "receivedAt"),
      }),
      prisma.webhookEvent.count({ where }),
    ]),
  );
}

/** FAILED → RECEIVED and processed again by a fresh "webhook.process" job. */
export async function replayWebhookEvent(ctx: AccessContext, id: string) {
  assertCan(ctx, "job.replay");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "webhook_events" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const event = await tx.webhookEvent.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!event) throw new AppError("NOT_FOUND", "Webhook event not found", 404);
    if (event.status !== "FAILED") throw new AppError("INVALID_STATE", `Only FAILED events can be replayed (event is ${event.status})`, 422);
    const updated = await tx.webhookEvent.update({ where: { id }, data: { status: "RECEIVED", error: null }, select: { id: true, status: true, attempts: true } });
    await enqueue(tx, { type: "webhook.process", key: `webhook.process:${id}:replay:${event.attempts}`, organizationId: ctx.organizationId, payload: { eventId: id } });
    await audit(tx, ctx, { action: "webhook_event.replayed", entity: "webhook_event", entityId: id, previous: { status: event.status, error: event.error }, next: { status: "RECEIVED" } });
    return updated;
  });
}

export async function listJobRuns(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "job.view");
  const q = runList.parse(query);
  const where: Prisma.JobRunWhereInput = { name: q.name, status: q.status };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.jobRun.findMany({ where, select: { id: true, name: true, status: true, startedAt: true, finishedAt: true }, ...listArgs(q, ["startedAt"], "startedAt") }),
      prisma.jobRun.count({ where }),
    ]),
  );
}
