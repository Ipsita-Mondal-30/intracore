import { cache } from "react";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import {
  buildTenantContext,
  hasPermission,
  requireOrganizationAccess,
  type TenantContext,
} from "@/lib/tenant";

/**
 * Tenant context plus the companies/branches the member may touch.
 * `companies` maps companyId -> allowed branch ids, or "all" for every branch.
 * Deny by default: no scope row means no access to that company's data.
 */
export type AccessContext = TenantContext & {
  companies: Map<string, Set<string> | "all">;
};

export async function buildAccessContext(
  userId: string,
  organizationId: string,
): Promise<AccessContext> {
  return withScopes(await buildTenantContext(userId, organizationId));
}

async function withScopes(tenant: TenantContext): Promise<AccessContext> {
  const companies = new Map<string, Set<string> | "all">();

  if (tenant.isOwner) {
    const rows = await prisma.company.findMany({
      where: { organizationId: tenant.organizationId },
      select: { id: true },
    });
    for (const row of rows) companies.set(row.id, "all");
  } else {
    const scopes = await prisma.memberScope.findMany({
      where: { organizationId: tenant.organizationId, memberId: tenant.membershipId },
      select: { companyId: true, branchId: true },
    });
    for (const { companyId, branchId } of scopes) {
      const current = companies.get(companyId);
      if (current === "all") continue;
      if (!branchId) companies.set(companyId, "all");
      else companies.set(companyId, new Set([...(current ?? []), branchId]));
    }
  }

  return { ...tenant, companies };
}

/** Request-scoped access context for the signed-in user (401/403 via AppError). */
export const getAccessContext = cache(async () =>
  withScopes(await requireOrganizationAccess()),
);

export function can(ctx: TenantContext, permission: string) {
  return hasPermission(ctx, permission);
}

export function assertCan(ctx: TenantContext, permission: string) {
  if (!can(ctx, permission)) {
    throw new AppError("FORBIDDEN", `Missing permission: ${permission}`, 403);
  }
}

/**
 * Throws unless the member is scoped to the company (and branch, when given).
 * Responds 404 rather than 403 so ids from other companies/tenants are not confirmed.
 */
export function assertCompanyAccess(
  ctx: AccessContext,
  companyId: string,
  branchId?: string | null,
) {
  const scope = ctx.companies.get(companyId);
  if (scope === "all") return; // branch/company pairing is enforced by composite FKs
  if (!scope) throw new AppError("NOT_FOUND", "Company not found", 404);
  // Branch-limited members must always name a branch they hold.
  if (!branchId) {
    throw new AppError("BRANCH_REQUIRED", "A branch you have access to is required", 422);
  }
  if (!scope.has(branchId)) throw new AppError("NOT_FOUND", "Branch not found", 404);
}

/** Prisma `where` fragment limiting company-scoped rows to the member's scopes. */
export function companyScopeWhere(ctx: AccessContext) {
  const or: { companyId: string; branchId?: { in: string[] } }[] = [];
  for (const [companyId, scope] of ctx.companies) {
    or.push(scope === "all" ? { companyId } : { companyId, branchId: { in: [...scope] } });
  }
  return {
    organizationId: ctx.organizationId,
    // An empty OR matches nothing in Prisma, which is the deny-by-default we want.
    OR: or,
  };
}
