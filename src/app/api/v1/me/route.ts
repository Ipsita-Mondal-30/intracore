import { api } from "@/lib/api/http";

export const GET = api(async (ctx) => ({
  userId: ctx.userId,
  organizationId: ctx.organizationId,
  organizationName: ctx.organizationName,
  role: ctx.roleName,
  isOwner: ctx.isOwner,
  permissions: [...ctx.permissions].sort(),
  companies: [...ctx.companies].map(([companyId, scope]) => ({
    companyId,
    branches: scope === "all" ? "all" : [...scope],
  })),
}));
