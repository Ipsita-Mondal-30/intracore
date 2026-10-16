import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { EXPENSE_ACTIONS, transitionExpenseClaim, type ExpenseAction } from "@/features/finance/expenses";

/** POST /expense-claims/:id/{submit|approve|reject|cancel|pay} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!EXPENSE_ACTIONS.includes(params.action as ExpenseAction)) throw new AppError("NOT_FOUND", "Unknown expense action", 404);
    return transitionExpenseClaim(ctx, params.id, params.action as ExpenseAction, body);
  },
  { idempotent: true },
);
