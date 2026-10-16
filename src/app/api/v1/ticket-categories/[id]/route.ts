import { api } from "@/lib/api/http";
import { updateTicketCategory } from "@/features/service/sla";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateTicketCategory(ctx, params.id, body));
