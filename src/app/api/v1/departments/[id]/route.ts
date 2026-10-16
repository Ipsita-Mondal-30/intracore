import { api } from "@/lib/api/http";
import { updateDepartment } from "@/features/hr/org";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateDepartment(ctx, params.id, body));
