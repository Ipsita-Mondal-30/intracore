import type { Prisma, PrismaClient } from "@prisma/client";
import type { TenantContext } from "@/lib/tenant";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Append an audit record. Pass the transaction client so the audit row commits
 * (or rolls back) together with the change it describes.
 */
export async function audit(
  db: Db,
  ctx: Pick<TenantContext, "organizationId" | "userId">,
  entry: {
    action: string;
    entity: string;
    entityId: string;
    companyId?: string | null;
    previous?: unknown;
    next?: unknown;
  },
) {
  await db.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      companyId: entry.companyId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      previous: toJson(entry.previous),
      next: toJson(entry.next),
    },
  });
}

/** Only the fields whose values changed, as { previous, next } for `audit`. */
export function changes<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) {
      previous[key] = a;
      next[key] = b;
    }
  }
  return { previous, next, changed: Object.keys(next).length > 0 };
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  // Round-trip drops undefined and turns Decimal/Date into JSON-safe strings.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
