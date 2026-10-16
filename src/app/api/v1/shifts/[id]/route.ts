import { api } from "@/lib/api/http";
import { updateShift } from "@/features/hr/org";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateShift(ctx, params.id, body));
