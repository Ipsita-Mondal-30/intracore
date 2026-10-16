import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { OPENING_ACTIONS, transitionJobOpening, type OpeningAction } from "@/features/hr/recruitment";

/** POST /job-openings/:id/{open|hold|close} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params }) => {
    if (!OPENING_ACTIONS.includes(params.action as OpeningAction)) throw new AppError("NOT_FOUND", "Unknown job opening action", 404);
    return transitionJobOpening(ctx, params.id, params.action as OpeningAction);
  },
  { idempotent: true },
);
