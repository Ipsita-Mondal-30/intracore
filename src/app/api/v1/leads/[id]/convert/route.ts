import { api } from "@/lib/api/http";
import { convertLead } from "@/features/leads/conversion";

/** Transactional and retry-safe; 409 DUPLICATE lists matching customers in `details`. */
export const POST = api<{ id: string }>((ctx, { params, body }) => convertLead(ctx, params.id, body), {
  idempotent: true,
});
