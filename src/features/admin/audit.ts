import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { assertCan, type AccessContext } from "@/lib/access";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";

const searchSchema = listQuerySchema.extend({
  userId: z.string().uuid().optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(100).optional(),
  /** "customer." matches customer.created, customer.updated … */
  action: z.string().trim().max(100).optional(),
  companyId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Audit trail search. Tenant-scoped: org-level entries plus entries of companies the
 * caller holds; `q` is free text within the action name.
 */
export async function searchAuditLogs(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "audit.view");
  const q = searchSchema.parse(query);
  const where: Prisma.AuditLogWhereInput = {
    organizationId: ctx.organizationId,
    OR: [{ companyId: null }, { companyId: { in: [...ctx.companies.keys()] } }],
    AND: [
      {
        userId: q.userId,
        entity: q.entity || undefined,
        entityId: q.entityId || undefined,
        companyId: q.companyId || undefined,
        action: q.action ? { startsWith: q.action } : undefined,
        createdAt: { gte: q.from, lte: q.to },
      },
      q.q ? { action: { contains: q.q, mode: "insensitive" } } : {},
    ],
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } } },
        ...listArgs(q, ["createdAt"]),
      }),
      prisma.auditLog.count({ where }),
    ]),
  );
}
