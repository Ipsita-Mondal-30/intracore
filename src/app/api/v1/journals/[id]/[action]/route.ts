import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { postManualJournal, reversePostedJournal } from "@/features/finance/journals";

/** POST /journals/:id/{post|reverse} — reverse takes { reason, date? } */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "post") return postManualJournal(ctx, params.id);
    if (params.action === "reverse") return reversePostedJournal(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown journal action", 404);
  },
  { idempotent: true },
);
