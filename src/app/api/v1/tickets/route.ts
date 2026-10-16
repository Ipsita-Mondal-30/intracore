import { api, queryObject } from "@/lib/api/http";
import { createTicket, listTickets } from "@/features/service/tickets";

export const GET = api((ctx, { query }) => listTickets(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createTicket(ctx, body), { status: 201, idempotent: true });
