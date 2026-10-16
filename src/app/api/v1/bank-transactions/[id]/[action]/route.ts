import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { reconcileBankTransaction, unreconcileBankTransaction } from "@/features/finance/bank";

/** POST /bank-transactions/:id/{reconcile|unreconcile} — reconcile takes { journalLineId } */
export const POST = api<{ id: string; action: string }>((ctx, { params, body }) => {
  if (params.action === "reconcile") return reconcileBankTransaction(ctx, params.id, body);
  if (params.action === "unreconcile") return unreconcileBankTransaction(ctx, params.id);
  throw new AppError("NOT_FOUND", "Unknown bank transaction action", 404);
});
