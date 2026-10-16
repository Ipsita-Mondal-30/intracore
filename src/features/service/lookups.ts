import { MemberStatus, RecordStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";

/** Select options for the service pages (tenant- and scope-filtered). */

export async function companyOptions(ctx: AccessContext) {
  const rows = await prisma.company.findMany({
    where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } },
    select: { id: true, code: true, name: true },
    orderBy: [{ isDefault: "desc" }, { code: "asc" }],
  });
  return rows.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }));
}

export async function customerOptions(ctx: AccessContext) {
  const rows = await prisma.customer.findMany({ where: { organizationId: ctx.organizationId, status: RecordStatus.ACTIVE }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 });
  return rows.map((c) => ({ id: c.id, label: c.name }));
}

export async function memberOptions(ctx: AccessContext) {
  const rows = await prisma.organizationMember.findMany({
    where: { organizationId: ctx.organizationId, status: MemberStatus.ACTIVE },
    select: { userId: true },
    orderBy: { joinedAt: "asc" },
  });
  const names = await userNames(rows.map((m) => m.userId));
  return rows.map((m) => ({ id: m.userId, label: names.get(m.userId) ?? m.userId }));
}

export async function userNames(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const rows = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
  return new Map(rows.map((u) => [u.id, u.name ?? u.email]));
}
