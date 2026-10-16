import { api } from "@/lib/api/http";
import { updateLeaveType } from "@/features/hr/leave";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateLeaveType(ctx, params.id, body));
