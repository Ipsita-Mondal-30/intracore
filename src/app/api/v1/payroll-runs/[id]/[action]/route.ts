import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { PAYROLL_RUN_ACTIONS, transitionPayrollRun, type PayrollRunAction } from "@/features/hr/payroll";

/** POST /payroll-runs/:id/{calculate|approve|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params }) => {
    if (!PAYROLL_RUN_ACTIONS.includes(params.action)) throw new AppError("NOT_FOUND", "Unknown payroll action", 404);
    return transitionPayrollRun(ctx, params.id, params.action as PayrollRunAction);
  },
  { idempotent: true },
);
