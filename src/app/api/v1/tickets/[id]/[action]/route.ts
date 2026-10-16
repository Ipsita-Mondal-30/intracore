import { api, queryObject } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { addTicketMessage, listTicketMessages, TICKET_ACTIONS, transitionTicket, type TicketAction } from "@/features/service/tickets";

type P = { id: string; action: string };

/** GET /tickets/:id/messages?visibility=PUBLIC|INTERNAL */
export const GET = api<P>((ctx, { params, query }) => {
  if (params.action === "messages") return listTicketMessages(ctx, params.id, queryObject(query));
  throw new AppError("NOT_FOUND", "Unknown ticket resource", 404);
});

/** POST /tickets/:id/{assign|start|hold|resolve|close|reopen|cancel|feedback|messages} */
export const POST = api<P>(
  (ctx, { params, body }) => {
    if (params.action === "messages") return addTicketMessage(ctx, params.id, body);
    if (!TICKET_ACTIONS.includes(params.action as TicketAction)) throw new AppError("NOT_FOUND", "Unknown ticket action", 404);
    return transitionTicket(ctx, params.id, params.action as TicketAction, body);
  },
  { idempotent: true },
);
