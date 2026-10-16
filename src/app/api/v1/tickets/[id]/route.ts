import { api } from "@/lib/api/http";
import { getTicket, updateTicket } from "@/features/service/tickets";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getTicket(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateTicket(ctx, params.id, body));
