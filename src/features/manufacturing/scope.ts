import { AppError } from "@/lib/errors";
import type { AccessContext } from "@/lib/access";

/**
 * Work orders, inspections and NCRs belong to a company but not a branch, so only members
 * with company-wide access see them (same rule as `resolveEntity` for these records).
 * Anything else answers 404, never 403.
 */
export const fullCompanyIds = (ctx: AccessContext) =>
  [...ctx.companies].filter(([, scope]) => scope === "all").map(([companyId]) => companyId);

export function assertFullCompany(ctx: AccessContext, companyId: string) {
  if (ctx.companies.get(companyId) !== "all") throw new AppError("NOT_FOUND", "Company not found", 404);
}
