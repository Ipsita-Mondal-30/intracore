import { api } from "@/lib/api/http";
import { getLeaveRequest } from "@/features/hr/leave";

export const GET = api<{ id: string }>((ctx, { params }) => getLeaveRequest(ctx, params.id));
