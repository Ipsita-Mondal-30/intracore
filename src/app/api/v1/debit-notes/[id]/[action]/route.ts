import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { cancelDebitNote, postDebitNote } from "@/features/finance/payables";

/** POST /debit-notes/:id/{post|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "post") return postDebitNote(ctx, params.id);
    if (params.action === "cancel") return cancelDebitNote(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown debit note action", 404);
  },
  { idempotent: true },
);
