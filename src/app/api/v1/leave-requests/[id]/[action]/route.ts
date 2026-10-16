import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { LEAVE_ACTIONS, transitionLeaveRequest, type LeaveAction } from "@/features/hr/leave";

/** POST /leave-requests/:id/{approve|reject|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!LEAVE_ACTIONS.includes(params.action as LeaveAction)) throw new AppError("NOT_FOUND", "Unknown leave action", 404);
    return transitionLeaveRequest(ctx, params.id, params.action as LeaveAction, body);
  },
  { idempotent: true },
);
