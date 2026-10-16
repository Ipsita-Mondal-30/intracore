import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { entityFields, TRIGGER_CATALOG } from "@/features/automation/catalog";
import { operatorsFor } from "@/features/automation/conditions";
import type { BuilderCatalog } from "./workflow-builder";

/** Catalog (with operators per field), active members and roles for the workflow builder. */
export async function builderData(ctx: AccessContext) {
  const catalog: BuilderCatalog = Object.fromEntries(
    Object.entries(TRIGGER_CATALOG).map(([key, def]) => [
      key,
      {
        label: def.label,
        actions: [...def.actions],
        fields: Object.fromEntries(Object.entries(entityFields(key)!).map(([f, fd]) => [f, { type: fd.type, options: fd.options ? [...fd.options] : undefined, ops: operatorsFor(fd) }])),
      },
    ]),
  );
  const [members, roles] = await Promise.all([
    prisma.organizationMember.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { user: { select: { id: true, name: true, email: true } } } }),
    prisma.role.findMany({ where: { organizationId: ctx.organizationId }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    catalog,
    members: members.map((m) => ({ value: m.user.id, label: m.user.name ?? m.user.email })),
    roles: roles.map((r) => ({ value: r.code, label: r.name })),
  };
}
