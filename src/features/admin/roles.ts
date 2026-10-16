import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { PERMISSIONS, SYSTEM_ROLE_TEMPLATES, systemRolePermissions } from "@/lib/permissions/catalog";

type Db = Prisma.TransactionClient | typeof prisma;

const CATALOG = new Set(PERMISSIONS.map((p) => p.code));
const SYSTEM_CODES = new Set(SYSTEM_ROLE_TEMPLATES.map((t) => t.code));

/**
 * Effective permission codes of a role, resolved exactly like `buildTenantContext`:
 * RolePermission rows, plus the code catalog for system roles.
 */
export function roleCodes(role: { code: string; isSystem: boolean; permissions: { permission: { code: string } }[] }) {
  return [
    ...new Set([
      ...role.permissions.map((rp) => rp.permission.code),
      ...(role.isSystem ? systemRolePermissions(role.code) : []),
    ]),
  ].sort();
}

const roleInclude = {
  permissions: { include: { permission: { select: { code: true } } } },
  _count: { select: { members: true, invitations: true } },
} satisfies Prisma.RoleInclude;

/** Nobody but an owner hands out (or edits) access they do not hold themselves. */
export function assertWithinOwnAccess(ctx: AccessContext, role: { code: string }, codes: string[]) {
  if (ctx.isOwner) return;
  const beyond = codes.filter((c) => !ctx.permissions.has(c));
  if (role.code === "owner" || beyond.length > 0) {
    throw new AppError("ROLE_ESCALATION", "That role grants more access than your own", 403, { permissions: beyond });
  }
}

export async function loadRole(db: Db, ctx: AccessContext, id: string) {
  const role = await db.role.findFirst({ where: { id, organizationId: ctx.organizationId }, include: roleInclude });
  if (!role) throw new AppError("NOT_FOUND", "Role not found", 404);
  return role;
}

const present = (role: Awaited<ReturnType<typeof loadRole>>) => {
  const { permissions, _count, ...rest } = role;
  return {
    ...rest,
    memberCount: _count.members,
    invitationCount: _count.invitations,
    permissions: roleCodes({ ...role, permissions }),
  };
};

export async function listRoles(ctx: AccessContext) {
  assertCan(ctx, "role.view");
  const roles = await prisma.role.findMany({
    where: { organizationId: ctx.organizationId },
    include: roleInclude,
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  return roles.map(present);
}

export async function getRole(ctx: AccessContext, id: string) {
  assertCan(ctx, "role.view");
  return present(await loadRole(prisma, ctx, id));
}

/** Catalog grouped by module, and each role's grant count per module. */
export async function getPermissionMatrix(ctx: AccessContext) {
  const roles = await listRoles(ctx);
  const modules = [...new Set(PERMISSIONS.map((p) => p.module))].map((module) => ({
    module,
    permissions: PERMISSIONS.filter((p) => p.module === module).map((p) => ({ code: p.code, name: p.name })),
  }));
  return {
    modules,
    roles: roles.map((role) => {
      const granted = new Set(role.permissions);
      return {
        id: role.id,
        code: role.code,
        name: role.name,
        isSystem: role.isSystem,
        memberCount: role.memberCount,
        modules: Object.fromEntries(
          modules.map((m) => [m.module, m.permissions.filter((p) => granted.has(p.code)).length]),
        ),
      };
    }),
  };
}

const permissionList = z
  .array(z.string().trim())
  .max(PERMISSIONS.length)
  .transform((codes) => [...new Set(codes)])
  .superRefine((codes, issue) => {
    const unknown = codes.filter((c) => !CATALOG.has(c));
    if (unknown.length) issue.addIssue({ code: "custom", message: `Unknown permission: ${unknown.join(", ")}` });
  });

const roleSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, "Code is 2-40 lowercase letters, digits or _")
    .refine((c) => !SYSTEM_CODES.has(c), "That code is reserved for a system role"),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullish(),
  permissions: permissionList,
});

/** Permission row ids for catalog codes, creating catalog rows a stale database lacks. */
async function permissionIds(tx: Prisma.TransactionClient, codes: string[]) {
  const rows = await tx.permission.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  for (const p of PERMISSIONS.filter((p) => codes.includes(p.code) && !rows.some((r) => r.code === p.code))) {
    rows.push(
      await tx.permission.upsert({
        where: { code: p.code },
        update: {},
        create: { code: p.code, name: p.name, module: p.module },
        select: { id: true, code: true },
      }),
    );
  }
  return rows.map((r) => r.id);
}

export async function createRole(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "role.manage");
  const data = roleSchema.parse(input);
  assertWithinOwnAccess(ctx, data, data.permissions);

  return prisma.$transaction(async (tx) => {
    const role = await tx.role.create({
      data: { organizationId: ctx.organizationId, code: data.code, name: data.name, description: data.description ?? null },
    });
    const ids = await permissionIds(tx, data.permissions);
    await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: role.id, permissionId })) });
    await audit(tx, ctx, {
      action: "role.created",
      entity: "role",
      entityId: role.id,
      next: { code: role.code, name: role.name, description: role.description, permissions: data.permissions },
    });
    return present(await loadRole(tx, ctx, role.id));
  });
}

export async function updateRole(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "role.manage");
  const data = roleSchema.omit({ code: true }).partial().parse(input);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM roles WHERE id = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const before = present(await loadRole(tx, ctx, id));
    if (before.isSystem) {
      throw new AppError("SYSTEM_ROLE", "System roles are read-only; their permissions come from the code catalog", 422);
    }
    // Editing a role is granting (and revoking) its access: both sides must be within the actor's own.
    assertWithinOwnAccess(ctx, before, before.permissions);
    if (data.permissions) assertWithinOwnAccess(ctx, before, data.permissions);

    await tx.role.update({
      where: { id },
      data: { name: data.name, description: data.description },
    });
    if (data.permissions) {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      const ids = await permissionIds(tx, data.permissions);
      await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: id, permissionId })) });
    }
    const after = present(await loadRole(tx, ctx, id));
    const added = after.permissions.filter((c) => !before.permissions.includes(c));
    const removed = before.permissions.filter((c) => !after.permissions.includes(c));
    await audit(tx, ctx, {
      action: "role.updated",
      entity: "role",
      entityId: id,
      previous: { name: before.name, description: before.description, removedPermissions: removed },
      next: { name: after.name, description: after.description, addedPermissions: added },
    });
    return after;
  });
}

export async function deleteRole(ctx: AccessContext, id: string) {
  assertCan(ctx, "role.manage");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM roles WHERE id = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const role = present(await loadRole(tx, ctx, id));
    if (role.isSystem) throw new AppError("SYSTEM_ROLE", "System roles cannot be deleted", 422);
    assertWithinOwnAccess(ctx, role, role.permissions);
    if (role.memberCount > 0 || role.invitationCount > 0) {
      throw new AppError("ROLE_IN_USE", "Reassign the members and invitations that use this role first", 422, {
        members: role.memberCount,
        invitations: role.invitationCount,
      });
    }
    await tx.role.delete({ where: { id } });
    await audit(tx, ctx, {
      action: "role.deleted",
      entity: "role",
      entityId: id,
      previous: { code: role.code, name: role.name, permissions: role.permissions },
    });
    return { id, deleted: true };
  });
}
