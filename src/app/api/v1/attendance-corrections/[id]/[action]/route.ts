import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { CORRECTION_ACTIONS, decideCorrection, type CorrectionAction } from "@/features/hr/attendance";

/** POST /attendance-corrections/:id/{approve|reject|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!CORRECTION_ACTIONS.includes(params.action as CorrectionAction)) throw new AppError("NOT_FOUND", "Unknown correction action", 404);
    return decideCorrection(ctx, params.id, params.action as CorrectionAction, body);
  },
  { idempotent: true },
);
