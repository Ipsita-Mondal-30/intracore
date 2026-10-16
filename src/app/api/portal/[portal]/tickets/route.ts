import { portalApi, salesPortalKind } from "@/features/portal/http";
import { createTicket, listTickets } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string }>(salesPortalKind, (p, { query }) => listTickets(p, Object.fromEntries(query)));
export const POST = portalApi<{ portal: string }>(salesPortalKind, (p, { body }) => createTicket(p, body), { status: 201, idempotent: true });
