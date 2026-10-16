import { z } from "zod";
import { MemberStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { assertWithinOwnAccess, loadRole, roleCodes } from "@/features/admin/roles";

const listSchema = listQuerySchema.extend({
  status: z.nativeEnum(MemberStatus).optional(),
  roleId: z.string().optional(),
});

/** Members with role, owner flag, status and company/branch scopes. */
export async function listMembers(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "member.view");
  const q = listSchema.parse(query);
  const where: Prisma.OrganizationMemberWhereInput = {
    organizationId: ctx.organizationId,
    status: q.status,
    roleId: q.roleId,
    ...(q.q
      ? {
          user: {
            OR: [
              { name: { contains: q.q, mode: "insensitive" } },
              { email: { contains: q.q, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.organizationMember.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
          role: { select: { id: true, code: true, name: true, isSystem: true } },
          scopes: {
            select: {
              companyId: true,
              branchId: true,
              company: { select: { code: true, name: true } },
              branch: { select: { code: true, name: true } },
            },
          },
        },
        ...listArgs(q, ["joinedAt"], "joinedAt"),
      }),
      prisma.organizationMember.count({ where }),
    ]),
  );
}

type Tx = Prisma.TransactionClient;

/** Locks the member row; 404 outside the tenant. */
async function lockMember(tx: Tx, ctx: AccessContext, memberId: string) {
  await tx.$queryRaw`SELECT id FROM organization_members WHERE id = ${memberId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const member = await tx.organizationMember.findFirst({
    where: { id: memberId, organizationId: ctx.organizationId },
    include: { role: { include: { permissions: { include: { permission: { select: { code: true } } } } } } },
  });
  if (!member) throw new AppError("NOT_FOUND", "Member not found", 404);
  if (member.userId === ctx.userId) {
    throw new AppError("SELF_CHANGE", "You cannot change your own role or status", 422);
  }
  // Non-owners may only manage members whose access is within their own.
  if (!ctx.isOwner) {
    if (member.isOwner) throw new AppError("FORBIDDEN", "Only an owner can change another owner", 403);
    assertWithinOwnAccess(ctx, member.role, roleCodes(member.role));
  }
  return member;
}

/** Owners are locked together so two owners cannot demote each other at the same time. */
async function assertAnotherOwner(tx: Tx, ctx: AccessContext, memberId: string) {
  const owners = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM organization_members
    WHERE "organizationId" = ${ctx.organizationId} AND "isOwner" = true AND status = 'ACTIVE'
    FOR UPDATE`;
  if (!owners.some((o) => o.id !== memberId)) {
    throw new AppError("LAST_OWNER", "The organization must keep at least one active owner", 422);
  }
}

export async function changeMemberRole(ctx: AccessContext, memberId: string, input: unknown) {
  assertCan(ctx, "member.change_role");
  const { roleId } = z.object({ roleId: z.string().min(1) }).parse(input);

  return prisma.$transaction(async (tx) => {
    const member = await lockMember(tx, ctx, memberId);
    const role = await loadRole(tx, ctx, roleId).catch(() => {
      throw new AppError("INVALID_REFERENCE", "Role does not belong to this organization", 422);
    });
    assertWithinOwnAccess(ctx, role, roleCodes(role));
    // Ownership follows the owner role.
    const isOwner = role.code === "owner";
    if (member.roleId === role.id && member.isOwner === isOwner) return member;
    if (member.isOwner && !isOwner) await assertAnotherOwner(tx, ctx, memberId);

    const updated = await tx.organizationMember.update({ where: { id: memberId }, data: { roleId: role.id, isOwner } });
    await audit(tx, ctx, {
      action: "member.role_changed",
      entity: "organization_member",
      entityId: memberId,
      previous: { roleId: member.roleId, roleCode: member.role.code, isOwner: member.isOwner },
      next: { roleId: role.id, roleCode: role.code, isOwner },
    });
    return updated;
  });
}

/** Suspend (DISABLED) or reactivate a member. Suspended members fail `buildTenantContext`. */
export async function setMemberStatus(ctx: AccessContext, memberId: string, status: MemberStatus) {
  assertCan(ctx, "member.remove");
  return prisma.$transaction(async (tx) => {
    const member = await lockMember(tx, ctx, memberId);
    if (member.status === status) return member;
    if (status === MemberStatus.DISABLED && member.isOwner) await assertAnotherOwner(tx, ctx, memberId);
    const updated = await tx.organizationMember.update({ where: { id: memberId }, data: { status } });
    await audit(tx, ctx, {
      action: status === MemberStatus.DISABLED ? "member.suspended" : "member.reactivated",
      entity: "organization_member",
      entityId: memberId,
      previous: { status: member.status },
      next: { status },
    });
    return updated;
  });
}
