import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { CLAIM_ACTIONS, transitionClaim, type ClaimAction } from "@/features/service/claims";

/** POST /service-claims/:id/{approve|reject|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (!CLAIM_ACTIONS.includes(params.action as ClaimAction)) throw new AppError("NOT_FOUND", "Unknown claim action", 404);
    return transitionClaim(ctx, params.id, params.action as ClaimAction, body);
  },
  { idempotent: true },
);
