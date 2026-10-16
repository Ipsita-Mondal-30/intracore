import type { Prisma, PrismaClient } from "@prisma/client";
import {
  PERMISSIONS,
  SYSTEM_ROLE_TEMPLATES,
  systemRolePermissions,
} from "@/lib/permissions/catalog";

type DbClient = PrismaClient | Prisma.TransactionClient;

/** Ensure global permission catalog exists (idempotent). */
export async function ensurePermissionsSeeded(db: DbClient) {
  // Compare codes, not counts: a renamed or removed code must not hide a missing one.
  const existing = new Set((await db.permission.findMany({ select: { code: true } })).map((p) => p.code));
  if (PERMISSIONS.every((p) => existing.has(p.code))) {
    return;
  }

  for (const permission of PERMISSIONS) {
    await db.permission.upsert({
      where: { code: permission.code },
      update: {
        name: permission.name,
        module: permission.module,
        description: permission.description ?? null,
      },
      create: {
        code: permission.code,
        name: permission.name,
        module: permission.module,
        description: permission.description ?? null,
      },
    });
  }
}

/**
 * Clone system role templates into an organization and attach permissions.
 * Call inside the same transaction that creates the organization.
 */
export async function seedOrganizationRoles(
  db: DbClient,
  organizationId: string,
  options?: { skipPermissionSeed?: boolean },
) {
  if (!options?.skipPermissionSeed) {
    await ensurePermissionsSeeded(db);
  }

  const allPermissions = await db.permission.findMany();
  const byCode = new Map(allPermissions.map((p) => [p.code, p]));

  const rolesByCode = new Map<string, string>();
  const rolePermissionLinks: { roleId: string; permissionId: string }[] = [];

  for (const template of SYSTEM_ROLE_TEMPLATES) {
    const role = await db.role.create({
      data: {
        organizationId,
        code: template.code,
        name: template.name,
        description: template.description,
        isSystem: true,
      },
    });
    rolesByCode.set(template.code, role.id);

    const permissionCodes = systemRolePermissions(template.code);

    for (const code of permissionCodes) {
      const permission = byCode.get(code);
      if (permission) {
        rolePermissionLinks.push({
          roleId: role.id,
          permissionId: permission.id,
        });
      }
    }
  }

  if (rolePermissionLinks.length > 0) {
    await db.rolePermission.createMany({
      data: rolePermissionLinks,
      skipDuplicates: true,
    });
  }

  return rolesByCode;
}
