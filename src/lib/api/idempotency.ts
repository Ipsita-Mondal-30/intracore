import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenant";

export type IdempotentResult = { status: number; body: unknown; replayed?: boolean };

/**
 * Run `fn` at most once per (user, Idempotency-Key). A retry with the same key and
 * body replays the stored response; the same key with a different body is rejected;
 * a retry while the first attempt is still running gets 409. Failed attempts
 * (thrown errors) release the key so the client can retry.
 * Without a key the request runs normally.
 */
export async function withIdempotency(
  ctx: Pick<TenantContext, "organizationId" | "userId">,
  key: string | null,
  rawBody: string,
  fn: () => Promise<IdempotentResult>,
): Promise<IdempotentResult> {
  if (!key) return fn();
  if (key.length > 200) {
    throw new AppError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is too long", 400);
  }

  const requestHash = createHash("sha256").update(rawBody).digest("hex");
  const where = {
    organizationId_userId_key: { organizationId: ctx.organizationId, userId: ctx.userId, key },
  };

  try {
    await prisma.idempotencyKey.create({
      data: { organizationId: ctx.organizationId, userId: ctx.userId, key, requestHash },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
    const existing = await prisma.idempotencyKey.findUnique({ where });
    if (!existing) return withIdempotency(ctx, key, rawBody, fn); // released meanwhile
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with a different request body",
        422,
      );
    }
    if (!existing.completedAt) {
      throw new AppError("IDEMPOTENCY_IN_PROGRESS", "The original request is still being processed", 409);
    }
    return {
      status: existing.responseStatus ?? 200,
      body: existing.responseBody,
      replayed: true,
    };
  }

  try {
    const result = await fn();
    await prisma.idempotencyKey.update({
      where,
      data: {
        responseStatus: result.status,
        responseBody: result.body as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    return result;
  } catch (error) {
    await prisma.idempotencyKey.delete({ where }).catch(() => {});
    throw error;
  }
}

/** Keys older than this are purged by the cleanup job. */
export const IDEMPOTENCY_TTL_HOURS = 24;

export async function purgeExpiredIdempotencyKeys(now = new Date()) {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_HOURS * 3600_000);
  const { count } = await prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { purged: count };
}
