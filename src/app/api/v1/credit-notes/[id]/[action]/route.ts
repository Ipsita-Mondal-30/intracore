import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { cancelCreditNote, postCreditNote } from "@/features/finance/receivables";

/** POST /credit-notes/:id/{post|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "post") return postCreditNote(ctx, params.id);
    if (params.action === "cancel") return cancelCreditNote(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown credit note action", 404);
  },
  { idempotent: true },
);
