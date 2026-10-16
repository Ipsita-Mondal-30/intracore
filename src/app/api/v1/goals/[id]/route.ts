import { api } from "@/lib/api/http";
import { updateGoal } from "@/features/hr/performance";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateGoal(ctx, params.id, body));
