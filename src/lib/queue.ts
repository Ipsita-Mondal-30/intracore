import { Prisma, type BackgroundJob, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { sanitizeError } from "@/lib/sanitize";
import { QUEUE_HANDLERS } from "@/lib/queue-handlers";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Persistent background queue with bounded retries.
 * - `enqueue` is idempotent on `key`: enqueueing the same key twice returns the first job.
 *   Pass the transaction client so the job commits together with the business change.
 * - `processQueue` claims due jobs with FOR UPDATE SKIP LOCKED, so overlapping runners never
 *   run a job twice. Failures back off exponentially; after `maxAttempts` a job is DEAD and
 *   waits for a controlled replay. Handlers must themselves be idempotent (a crash after the
 *   side effect but before SUCCEEDED is recorded re-runs the handler).
 */
export async function enqueue(
  db: Db,
  job: { type: keyof typeof QUEUE_HANDLERS; key: string; organizationId?: string | null; payload?: Prisma.InputJsonValue; runAt?: Date; maxAttempts?: number },
): Promise<BackgroundJob> {
  const created = await db.backgroundJob.createMany({
    data: [{
      type: job.type,
      key: job.key,
      organizationId: job.organizationId ?? null,
      payload: job.payload ?? {},
      runAt: job.runAt ?? new Date(),
      maxAttempts: job.maxAttempts ?? 5,
    }],
    skipDuplicates: true,
  });
  const row = await db.backgroundJob.findUniqueOrThrow({ where: { key: job.key } });
  if (created.count === 0 && row.type !== job.type) throw new Error(`Job key ${job.key} already used by ${row.type}`);
  return row;
}

export const STALE_LOCK_MS = 10 * 60 * 1000;
const HANDLER_TIMEOUT_MS = 30_000;

/** Delay before retry n (1-based): 1, 2, 4 … minutes, capped at 1 hour. */
export const backoffMs = (attempt: number) => Math.min(60 * 60_000, 60_000 * 2 ** (attempt - 1));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export async function processQueue({ limit = 50, now = new Date(), types }: { limit?: number; now?: Date; types?: string[] } = {}) {
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
  const typeFilter = types?.length ? Prisma.sql`AND "type" IN (${Prisma.join(types)})` : Prisma.empty;
  // Prisma stores timestamp(3) columns as UTC wall-clock time; compare in UTC whatever the session timezone.
  const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
  const claimed = await prisma.$queryRaw<BackgroundJob[]>`
    UPDATE "background_jobs" SET "status" = 'RUNNING', "lockedAt" = ${utc(now)}, "attempts" = "attempts" + 1, "updatedAt" = ${utc(now)}
    WHERE "id" IN (
      SELECT "id" FROM "background_jobs"
      WHERE (("status" = 'PENDING' AND "runAt" <= ${utc(now)}) OR ("status" = 'RUNNING' AND "lockedAt" < ${utc(staleBefore)})) ${typeFilter}
      ORDER BY "runAt" LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;

  const summary = { claimed: claimed.length, succeeded: 0, retried: 0, dead: 0 };
  for (const job of claimed) {
    const handler = QUEUE_HANDLERS[job.type as keyof typeof QUEUE_HANDLERS];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      const result = await withTimeout(handler(job.payload as never, job), HANDLER_TIMEOUT_MS);
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: "SUCCEEDED", result: (result ?? Prisma.JsonNull) as Prisma.InputJsonValue, lastError: null, lockedAt: null, finishedAt: new Date() },
      });
      summary.succeeded++;
    } catch (error) {
      const dead = job.attempts >= job.maxAttempts;
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: {
          status: dead ? "DEAD" : "PENDING",
          lastError: sanitizeError(error),
          lockedAt: null,
          runAt: dead ? job.runAt : new Date(now.getTime() + backoffMs(job.attempts)),
          finishedAt: dead ? new Date() : null,
        },
      });
      if (dead) summary.dead++;
      else summary.retried++;
    }
  }
  return summary;
}
