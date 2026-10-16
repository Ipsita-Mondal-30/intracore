import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { reconcileStock } from "@/features/inventory/stock";

/** { companyId, fix?: boolean } — compares cached balances/valuation with the ledger. */
export const POST = api(async (ctx, { body }) => {
  const { companyId, ...rest } = (body ?? {}) as { companyId?: string };
  if (!companyId) throw new AppError("VALIDATION_ERROR", "companyId is required", 422);
  return reconcileStock(ctx, companyId, rest);
});
