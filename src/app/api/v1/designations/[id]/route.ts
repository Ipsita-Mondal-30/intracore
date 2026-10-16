import { api } from "@/lib/api/http";
import { updateDesignation } from "@/features/hr/org";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateDesignation(ctx, params.id, body));
