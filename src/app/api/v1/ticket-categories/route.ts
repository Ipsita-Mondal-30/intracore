import { api } from "@/lib/api/http";
import { createTicketCategory, listTicketCategories } from "@/features/service/sla";

export const GET = api((ctx) => listTicketCategories(ctx));
export const POST = api((ctx, { body }) => createTicketCategory(ctx, body), { status: 201, idempotent: true });
