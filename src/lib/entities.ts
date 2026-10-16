import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCompanyAccess, type AccessContext } from "@/lib/access";
import { leadVisibilityWhere } from "@/features/leads/scope";

/**
 * Records that tasks and documents may attach to. Each resolver returns the record's
 * companyId (null for org-level records) only if the caller may access it, so a
 * client-supplied entityType/entityId is never trusted.
 */
type Resolver = (ctx: AccessContext, id: string) => Promise<{ companyId: string | null } | null>;

const resolvers: Record<string, Resolver> = {
  company: async (ctx, id) => (ctx.companies.has(id) ? { companyId: id } : null),
  branch: async (ctx, id) => {
    const branch = await prisma.branch.findFirst({
      where: { id, organizationId: ctx.organizationId },
      select: { companyId: true },
    });
    if (!branch) return null;
    assertCompanyAccess(ctx, branch.companyId, id);
    return { companyId: branch.companyId };
  },
  lead: async (ctx, id) => {
    const lead = await prisma.lead.findFirst({
      where: { id, ...leadVisibilityWhere(ctx) },
      select: { id: true },
    });
    return lead ? { companyId: null } : null;
  },
};

export function registerEntity(type: string, resolver: Resolver) {
  resolvers[type] = resolver;
}

export const entityTypes = () => Object.keys(resolvers);

export async function resolveEntity(ctx: AccessContext, type: string, id: string) {
  const resolver = resolvers[type];
  if (!resolver) {
    throw new AppError("VALIDATION_ERROR", `Unsupported entityType: ${type}`, 422);
  }
  const found = await resolver(ctx, id);
  if (!found) throw new AppError("NOT_FOUND", `${type} not found`, 404);
  return found;
}
