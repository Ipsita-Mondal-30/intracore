import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { CYCLE_ACTIONS, transitionReviewCycle, type CycleAction } from "@/features/hr/performance";

/** POST /review-cycles/:id/{activate|close} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params }) => {
    if (!CYCLE_ACTIONS.includes(params.action as CycleAction)) throw new AppError("NOT_FOUND", "Unknown review cycle action", 404);
    return transitionReviewCycle(ctx, params.id, params.action as CycleAction);
  },
  { idempotent: true },
);
