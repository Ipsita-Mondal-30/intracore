import { api } from "@/lib/api/http";
import { updateSlaPolicy } from "@/features/service/sla";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateSlaPolicy(ctx, params.id, body));
