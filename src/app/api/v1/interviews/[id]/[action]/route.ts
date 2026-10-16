import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { INTERVIEW_ACTIONS, interviewAction, type InterviewAction } from "@/features/hr/recruitment";

/** POST /interviews/:id/{complete|cancel|feedback} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!INTERVIEW_ACTIONS.includes(params.action as InterviewAction)) throw new AppError("NOT_FOUND", "Unknown interview action", 404);
    return interviewAction(ctx, params.id, params.action as InterviewAction, body);
  },
  { idempotent: true },
);
