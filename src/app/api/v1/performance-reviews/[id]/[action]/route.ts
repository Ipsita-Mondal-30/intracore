import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { REVIEW_ACTIONS, submitPerformanceReview, type ReviewAction } from "@/features/hr/performance";

/** POST /performance-reviews/:id/{self|manager} { rating, comments? } */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!REVIEW_ACTIONS.includes(params.action as ReviewAction)) throw new AppError("NOT_FOUND", "Unknown review action", 404);
    return submitPerformanceReview(ctx, params.id, params.action as ReviewAction, body);
  },
  { idempotent: true },
);
