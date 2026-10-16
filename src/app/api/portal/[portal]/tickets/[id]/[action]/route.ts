import { AppError } from "@/lib/errors";
import { portalApi, salesPortalKind } from "@/features/portal/http";
import { giveTicketFeedback, replyToTicket } from "@/features/portal/customer";

/** POST reply { body } | feedback { rating, comment? } */
export const POST = portalApi<{ portal: string; id: string; action: string }>(
  salesPortalKind,
  (p, { params, body }) => {
    if (params.action === "reply") return replyToTicket(p, params.id, body);
    if (params.action === "feedback") return giveTicketFeedback(p, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown action", 404);
  },
  { idempotent: true },
);
