import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { EMPLOYEE_ACTIONS, transitionEmployee, type EmployeeAction } from "@/features/hr/employees";

/** POST /employees/:id/{activate|confirm|transfer|promote|notice|withdraw_notice|exit} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!EMPLOYEE_ACTIONS.includes(params.action as EmployeeAction)) throw new AppError("NOT_FOUND", "Unknown employee action", 404);
    return transitionEmployee(ctx, params.id, params.action as EmployeeAction, body);
  },
  { idempotent: true },
);
