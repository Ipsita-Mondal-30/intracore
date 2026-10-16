import { api } from "@/lib/api/http";
import { assertCan, assertCompanyAccess } from "@/lib/access";
import { AppError } from "@/lib/errors";
import { getReorderSuggestions } from "@/features/inventory/stock";

/** ?companyId= — products at or below their reorder level, net of open purchase orders. */
export const GET = api(async (ctx, { query }) => {
  assertCan(ctx, "inventory.view");
  const companyId = query.get("companyId");
  if (!companyId) throw new AppError("VALIDATION_ERROR", "companyId is required", 422);
  assertCompanyAccess(ctx, companyId);
  return getReorderSuggestions(ctx, companyId);
});
