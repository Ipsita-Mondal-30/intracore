import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { DISPATCH_ACTIONS, transitionDispatch, type DispatchAction } from "@/features/service/dispatch";

/** POST /dispatches/:id/{in-transit|deliver|fail} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!DISPATCH_ACTIONS.includes(params.action as DispatchAction)) throw new AppError("NOT_FOUND", "Unknown dispatch action", 404);
    return transitionDispatch(ctx, params.id, params.action as DispatchAction, body);
  },
  { idempotent: true },
);
