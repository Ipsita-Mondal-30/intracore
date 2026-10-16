import { api, queryObject } from "@/lib/api/http";
import { applyLeave, listLeaveRequests } from "@/features/hr/leave";

export const GET = api((ctx, { query }) => listLeaveRequests(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => applyLeave(ctx, body), { status: 201, idempotent: true });
