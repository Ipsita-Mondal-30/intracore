import { api } from "@/lib/api/http";
import { updateTask } from "@/features/tasks/service";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateTask(ctx, params.id, body));
