import { cache } from "react";
import { MemberStatus } from "@prisma/client";
import { hasSupabasePublicEnv } from "@/lib/config/env";
import { getSupabaseAuthUser } from "@/lib/auth/supabase-user";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { ensurePrismaUser } from "@/lib/auth/ensure-user";
import { perfTime } from "@/lib/perf";
import { systemRolePermissions } from "@/lib/permissions/catalog";

export { assertSameOrganization } from "@/lib/tenant/assert";

export type SessionContext = {
  userId: string;
  email: string | null | undefined;
  name: string | null | undefined;
  activeOrganizationId: string | null;
  membershipId: string | null;
};

export type TenantContext = {
  userId: string;
  organizationId: string;
  membershipId: string;
  roleId: string;
  roleName: string;
  isOwner: boolean;
  permissions: Set<string>;
  organizationName: string;
  organizationCurrency: string;
  userName: string | null;
  userEmail: string | null;
};

async function loadSessionContext(): Promise<SessionContext | null> {
  if (!hasSupabasePublicEnv()) {
    return null;
  }

  const authTimer = perfTime("auth.getUser+ensureUser");
  try {
    const user = await getSupabaseAuthUser();
    if (!user) {
      authTimer.end();
      return null;
    }

    const dbUser = await ensurePrismaUser(user);
    authTimer.end();

    return {
      userId: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      activeOrganizationId: dbUser.activeOrganizationId,
      membershipId: null,
    };
  } catch (error) {
    authTimer.end();
    console.error("getSessionContext failed", error);
    return null;
  }
}

/** Request-scoped: layout and pages share one auth + user lookup. */
export const getSessionContext = cache(loadSessionContext);

export async function requireAuth(): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx) {
    throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  }
  return ctx;
}

/**
 * Membership + role + permissions for a user in an organization, straight from the DB.
 * Used by request auth below, and directly by tests and background jobs.
 */
export async function buildTenantContext(
  userId: string,
  organizationId: string,
): Promise<TenantContext> {
  const timer = perfTime("prisma.membership+role+org");
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: {
      user: { select: { name: true, email: true } },
      organization: { select: { name: true, currency: true } },
      role: {
        include: {
          permissions: {
            include: { permission: { select: { code: true } } },
          },
        },
      },
    },
  });
  timer.end();

  if (!membership || membership.status !== MemberStatus.ACTIVE) {
    throw new AppError(
      "FORBIDDEN",
      "You do not have access to this organization",
      403,
    );
  }

  // System roles follow the code catalog, so permissions added in later releases
  // reach existing organizations without a data backfill.
  const permissions = new Set([
    ...membership.role.permissions.map((rp) => rp.permission.code),
    ...(membership.role.isSystem ? systemRolePermissions(membership.role.code) : []),
  ]);

  return {
    userId,
    organizationId: membership.organizationId,
    membershipId: membership.id,
    roleId: membership.roleId,
    roleName: membership.role.name,
    isOwner: membership.isOwner,
    permissions,
    organizationName: membership.organization.name,
    organizationCurrency: membership.organization.currency,
    userName: membership.user.name,
    userEmail: membership.user.email,
  };
}

async function loadOrganizationAccess(
  organizationId?: string,
): Promise<TenantContext> {
  const session = await requireAuth();
  const orgId = organizationId ?? session.activeOrganizationId;

  if (!orgId) {
    throw new AppError(
      "NO_ORGANIZATION",
      "No active organization. Create or join an organization first.",
      403,
    );
  }

  const tenant = await buildTenantContext(session.userId, orgId);

  if (session.activeOrganizationId !== tenant.organizationId) {
    await prisma.user.update({
      where: { id: session.userId },
      data: { activeOrganizationId: tenant.organizationId },
    });
  }

  return tenant;
}

/** Request-scoped tenant + RBAC. Pages should call this (or requirePermission), not getUser again. */
export const requireOrganizationAccess = cache(loadOrganizationAccess);

export async function getCurrentOrganization() {
  const tenant = await requireOrganizationAccess();
  const organization = await prisma.organization.findFirst({
    where: { id: tenant.organizationId },
  });
  if (!organization) {
    throw new AppError("NOT_FOUND", "Organization not found", 404);
  }
  return { organization, tenant };
}

export async function requirePermission(
  permissionCode: string,
): Promise<TenantContext> {
  const tenant = await requireOrganizationAccess();
  if (tenant.isOwner || tenant.permissions.has(permissionCode)) {
    return tenant;
  }
  throw new AppError(
    "FORBIDDEN",
    `Missing permission: ${permissionCode}`,
    403,
  );
}

export function hasPermission(
  tenant: TenantContext,
  permissionCode: string,
): boolean {
  return tenant.isOwner || tenant.permissions.has(permissionCode);
}
