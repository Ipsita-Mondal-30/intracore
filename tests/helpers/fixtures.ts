import { randomUUID } from "crypto";
import { prisma } from "@/lib/db/prisma";
import { seedOrganizationRoles } from "@/lib/permissions/seed-org-roles";
import { seedOrganizationLeadDefaults } from "@/lib/leads/seed-defaults";
import { seedDefaultCompany } from "@/features/companies/service";
import { buildAccessContext } from "@/lib/access";

/**
 * Throwaway tenants for DB tests. Every org gets roles, lead defaults and a default
 * company + HO branch, exactly like organization creation in the app.
 */
const created = { orgs: [] as string[], users: [] as string[] };

export async function createUser(label = "user") {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${label}-${id}@test.local`, name: label } });
  created.users.push(id);
  return id;
}

export async function createOrg(name = "Org") {
  const ownerId = await createUser("owner");
  const org = await prisma.organization.create({
    data: { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${randomUUID().slice(0, 8)}`, currency: "INR" },
  });
  created.orgs.push(org.id);
  const roles = await seedOrganizationRoles(prisma, org.id);
  await seedOrganizationLeadDefaults(prisma, org.id);
  const company = await seedDefaultCompany(prisma, org);
  const branch = await prisma.branch.findFirstOrThrow({ where: { companyId: company.id } });
  await prisma.organizationMember.create({
    data: { organizationId: org.id, userId: ownerId, roleId: roles.get("owner")!, isOwner: true },
  });
  await prisma.user.update({ where: { id: ownerId }, data: { activeOrganizationId: org.id } });

  return {
    org,
    company,
    branch,
    ownerId,
    roles,
    /** Add a member with a system role and optional scopes (default: whole default company). */
    async addMember(roleCode: string, scopes?: { companyId: string; branchId?: string }[]) {
      const userId = await createUser(roleCode);
      const member = await prisma.organizationMember.create({
        data: { organizationId: org.id, userId, roleId: roles.get(roleCode)! },
      });
      await prisma.memberScope.createMany({
        data: (scopes ?? [{ companyId: company.id }]).map((s) => ({
          organizationId: org.id,
          memberId: member.id,
          companyId: s.companyId,
          branchId: s.branchId ?? null,
        })),
      });
      await prisma.user.update({ where: { id: userId }, data: { activeOrganizationId: org.id } });
      return { userId, memberId: member.id };
    },
    ctx: (userId: string) => buildAccessContext(userId, org.id),
  };
}

export type OrgFixture = Awaited<ReturnType<typeof createOrg>>;

export async function cleanupFixtures() {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: created.orgs } } });
  await prisma.organization.deleteMany({ where: { id: { in: created.orgs } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  created.orgs = [];
  created.users = [];
}
