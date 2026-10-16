import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { VISIT_ACTIONS, transitionVisit, type VisitAction } from "@/features/service/field";

/** POST /service-visits/:id/{start|complete|cancel|no-show} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!VISIT_ACTIONS.includes(params.action as VisitAction)) throw new AppError("NOT_FOUND", "Unknown visit action", 404);
    return transitionVisit(ctx, params.id, params.action as VisitAction, body);
  },
  { idempotent: true },
);
