import Papa from "papaparse";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { putObject } from "@/lib/storage/objects";
import { sanitizeError } from "@/lib/sanitize";
import { DOCUMENTS_BUCKET } from "@/features/documents/service";

/**
 * Data retention. Only the targets below can ever be purged; posted financial records,
 * stock moves, journals and every other business record are deliberately absent.
 * Each run deletes at most BATCH_LIMIT rows per target, oldest first.
 */
export const BATCH_LIMIT = 5000;
const DAY = 86_400_000;

type Target = {
  label: string;
  rule: string;
  minKeepDays: number;
  /** Only org owners may configure it (and the rows are archived before deletion). */
  ownerOnly?: boolean;
  count: (organizationId: string, cutoff: Date) => Promise<number>;
  /** Oldest matching ids, at most `take`. */
  ids: (organizationId: string, cutoff: Date, take: number) => Promise<string[]>;
  remove: (ids: string[]) => Promise<number>;
};

// Communication logs: QUEUED rows are still in flight and BLOCKED rows are the evidence that
// consent rules stopped a message, so both are kept; delivered/failed history is purgeable.
const PURGEABLE_COMMUNICATION = ["SENT", "DELIVERED", "READ", "FAILED", "RECEIVED"];

const notificationWhere = (organizationId: string, cutoff: Date): Prisma.NotificationWhereInput => ({ organizationId, readAt: { not: null }, createdAt: { lt: cutoff } });
const communicationWhere = (organizationId: string, cutoff: Date): Prisma.CommunicationLogWhereInput => ({ organizationId, status: { in: PURGEABLE_COMMUNICATION }, createdAt: { lt: cutoff } });
const webhookWhere = (organizationId: string, cutoff: Date): Prisma.WebhookEventWhereInput => ({ organizationId, status: { in: ["PROCESSED", "IGNORED"] }, receivedAt: { lt: cutoff } });
const jobWhere = (organizationId: string, cutoff: Date): Prisma.BackgroundJobWhereInput => ({ organizationId, status: "SUCCEEDED", finishedAt: { lt: cutoff } });
const auditWhere = (organizationId: string, cutoff: Date): Prisma.AuditLogWhereInput => ({ organizationId, createdAt: { lt: cutoff } });
const pluck = (rows: { id: string }[]) => rows.map((r) => r.id);

export const RETENTION_TARGETS: Record<string, Target> = {
  notifications: {
    label: "Notifications",
    rule: "Read notifications older than the retention period",
    minKeepDays: 7,
    count: (o, c) => prisma.notification.count({ where: notificationWhere(o, c) }),
    ids: async (o, c, take) => pluck(await prisma.notification.findMany({ where: notificationWhere(o, c), select: { id: true }, orderBy: { createdAt: "asc" }, take })),
    remove: async (ids) => (await prisma.notification.deleteMany({ where: { id: { in: ids } } })).count,
  },
  communication_logs: {
    label: "Communication logs",
    rule: "Sent, delivered, read, failed and received messages; queued and consent-blocked messages are kept",
    minKeepDays: 30,
    count: (o, c) => prisma.communicationLog.count({ where: communicationWhere(o, c) }),
    ids: async (o, c, take) => pluck(await prisma.communicationLog.findMany({ where: communicationWhere(o, c), select: { id: true }, orderBy: { createdAt: "asc" }, take })),
    remove: async (ids) => (await prisma.communicationLog.deleteMany({ where: { id: { in: ids } } })).count,
  },
  webhook_events: {
    label: "Webhook events",
    rule: "Processed and ignored events; failed and pending events are kept for replay",
    minKeepDays: 7,
    count: (o, c) => prisma.webhookEvent.count({ where: webhookWhere(o, c) }),
    ids: async (o, c, take) => pluck(await prisma.webhookEvent.findMany({ where: webhookWhere(o, c), select: { id: true }, orderBy: { receivedAt: "asc" }, take })),
    remove: async (ids) => (await prisma.webhookEvent.deleteMany({ where: { id: { in: ids } } })).count,
  },
  background_jobs: {
    label: "Background jobs",
    rule: "Succeeded jobs; pending, running and dead jobs are kept",
    minKeepDays: 7,
    count: (o, c) => prisma.backgroundJob.count({ where: jobWhere(o, c) }),
    ids: async (o, c, take) => pluck(await prisma.backgroundJob.findMany({ where: jobWhere(o, c), select: { id: true }, orderBy: { finishedAt: "asc" }, take })),
    remove: async (ids) => (await prisma.backgroundJob.deleteMany({ where: { id: { in: ids } } })).count,
  },
  audit_logs: {
    label: "Audit logs",
    rule: "Entries older than the retention period (minimum 365 days), archived as CSV to private storage first",
    minKeepDays: 365,
    ownerOnly: true,
    count: (o, c) => prisma.auditLog.count({ where: auditWhere(o, c) }),
    ids: async (o, c, take) => pluck(await prisma.auditLog.findMany({ where: auditWhere(o, c), select: { id: true }, orderBy: { createdAt: "asc" }, take })),
    remove: async (ids) => (await prisma.auditLog.deleteMany({ where: { id: { in: ids } } })).count,
  },
};

function targetDef(target: string) {
  const def = RETENTION_TARGETS[target];
  if (!def) throw new AppError("NOT_FOUND", "Unknown retention target", 404);
  return def;
}

function assertManage(ctx: AccessContext, def: Target) {
  assertCan(ctx, "retention.manage");
  if (def.ownerOnly && !ctx.isOwner) {
    throw new AppError("FORBIDDEN", "Only an organization owner can manage audit log retention", 403);
  }
}

export async function listRetentionPolicies(ctx: AccessContext) {
  assertCan(ctx, "retention.manage");
  const policies = await prisma.retentionPolicy.findMany({ where: { organizationId: ctx.organizationId } });
  return Object.entries(RETENTION_TARGETS).map(([target, def]) => ({
    target,
    label: def.label,
    rule: def.rule,
    minKeepDays: def.minKeepDays,
    ownerOnly: Boolean(def.ownerOnly),
    policy: policies.find((p) => p.target === target) ?? null,
  }));
}

const policySchema = (min: number) =>
  z.object({
    keepDays: z.coerce.number().int().min(min, `Keep at least ${min} days`).max(3650),
    isEnabled: z.boolean().default(false),
  });

export async function upsertRetentionPolicy(ctx: AccessContext, target: string, input: unknown) {
  const def = targetDef(target);
  assertManage(ctx, def);
  const data = policySchema(def.minKeepDays).parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.retentionPolicy.findUnique({ where: { organizationId_target: { organizationId: ctx.organizationId, target } } });
    const policy = await tx.retentionPolicy.upsert({
      where: { organizationId_target: { organizationId: ctx.organizationId, target } },
      create: { organizationId: ctx.organizationId, target, ...data, updatedById: ctx.userId },
      update: { ...data, updatedById: ctx.userId },
    });
    await audit(tx, ctx, {
      action: before ? "retention.policy_updated" : "retention.policy_created",
      entity: "retention_policy",
      entityId: policy.id,
      previous: before ? { keepDays: before.keepDays, isEnabled: before.isEnabled } : undefined,
      next: { target, ...data },
    });
    return policy;
  });
}

export async function deleteRetentionPolicy(ctx: AccessContext, target: string) {
  const def = targetDef(target);
  assertManage(ctx, def);
  return prisma.$transaction(async (tx) => {
    const policy = await tx.retentionPolicy.findUnique({ where: { organizationId_target: { organizationId: ctx.organizationId, target } } });
    if (!policy) throw new AppError("NOT_FOUND", "Retention policy not found", 404);
    await tx.retentionPolicy.delete({ where: { id: policy.id } });
    await audit(tx, ctx, { action: "retention.policy_deleted", entity: "retention_policy", entityId: policy.id, previous: policy });
    return { target, deleted: true };
  });
}

/** Dry run: how many rows a policy with `keepDays` would purge now (and in this run). */
export async function previewRetention(ctx: AccessContext, target: string, query: unknown) {
  const def = targetDef(target);
  assertCan(ctx, "retention.manage");
  const policy = await prisma.retentionPolicy.findUnique({ where: { organizationId_target: { organizationId: ctx.organizationId, target } } });
  const { keepDays } = policySchema(def.minKeepDays)
    .pick({ keepDays: true })
    .parse({ keepDays: (query as { keepDays?: unknown })?.keepDays ?? policy?.keepDays ?? def.minKeepDays });
  const cutoff = new Date(Date.now() - keepDays * DAY);
  const count = await def.count(ctx.organizationId, cutoff);
  return { target, keepDays, cutoff, count, thisRun: Math.min(count, BATCH_LIMIT), batchLimit: BATCH_LIMIT };
}

const csvCell = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : v);

/** Writes the audit rows to private storage; throws (so nothing is deleted) when the upload fails. */
async function archiveAuditLogs(organizationId: string, ids: string[], now: Date) {
  const rows = await prisma.auditLog.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } });
  const csv = Papa.unparse(rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, csvCell(v)]))));
  const path = `archives/${organizationId}/audit-${now.toISOString().replace(/[:.]/g, "-")}.csv`;
  await putObject(DOCUMENTS_BUCKET, path, Buffer.from(csv, "utf8"), "text/csv");
  return path;
}

/**
 * Job "retention": applies every enabled policy (or one org's). Idempotent: rows already
 * purged no longer match, and each policy is claimed with a conditional update on
 * lastRunAt so overlapping runs never process the same policy twice.
 */
export async function applyRetentionPolicies(now = new Date(), organizationId?: string) {
  const policies = await prisma.retentionPolicy.findMany({ where: { isEnabled: true, organizationId } });
  const results: { organizationId: string; target: string; purged: number; archive?: string; error?: string }[] = [];

  for (const policy of policies) {
    const def = RETENTION_TARGETS[policy.target];
    if (!def) continue;
    const claimed = await prisma.retentionPolicy.updateMany({
      where: { id: policy.id, lastRunAt: policy.lastRunAt, isEnabled: true },
      data: { lastRunAt: now },
    });
    if (claimed.count === 0) continue;

    const keepDays = Math.max(policy.keepDays, def.minKeepDays);
    const cutoff = new Date(now.getTime() - keepDays * DAY);
    const result: (typeof results)[number] = { organizationId: policy.organizationId, target: policy.target, purged: 0 };
    try {
      const ids = await def.ids(policy.organizationId, cutoff, BATCH_LIMIT);
      if (ids.length) {
        if (policy.target === "audit_logs") result.archive = await archiveAuditLogs(policy.organizationId, ids, now);
        result.purged = await def.remove(ids);
      }
    } catch (error) {
      result.error = sanitizeError(error);
    }
    await prisma.retentionPolicy.update({ where: { id: policy.id }, data: { lastPurged: result.purged } });
    if (result.purged || result.error) {
      await prisma.auditLog.create({
        data: {
          organizationId: policy.organizationId,
          action: result.error ? "retention.failed" : "retention.purged",
          entity: "retention_policy",
          entityId: policy.id,
          next: { target: policy.target, keepDays, cutoff: cutoff.toISOString(), purged: result.purged, archive: result.archive, error: result.error },
        },
      });
    }
    results.push(result);
  }
  return { policies: results.length, purged: results.reduce((sum, r) => sum + r.purged, 0), results };
}

/** "Run now" from the retention page: this organization's enabled policies only. */
export async function runRetentionNow(ctx: AccessContext) {
  assertCan(ctx, "retention.manage");
  return applyRetentionPolicies(new Date(), ctx.organizationId);
}
