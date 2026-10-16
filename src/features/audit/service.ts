import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { assertCan, type AccessContext } from "@/lib/access";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";

const listSchema = listQuerySchema.extend({
  entity: z.string().optional(),
  entityId: z.string().optional(),
  companyId: z.string().optional(),
  userId: z.string().uuid().optional(),
  action: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Org-level entries plus entries for companies the caller is scoped to. */
export async function listAuditLogs(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "audit.view");
  const q = listSchema.parse(query);
  const where: Prisma.AuditLogWhereInput = {
    organizationId: ctx.organizationId,
    OR: [{ companyId: null }, { companyId: { in: [...ctx.companies.keys()] } }],
    AND: [
      {
        entity: q.entity,
        entityId: q.entityId,
        companyId: q.companyId,
        userId: q.userId,
        action: q.action,
        createdAt: { gte: q.from, lte: q.to },
      },
    ],
  };
  return paginate(q, () =>
    Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } } },
        ...listArgs(q, ["createdAt"]),
      }),
      prisma.auditLog.count({ where }),
    ]),
  );
}
