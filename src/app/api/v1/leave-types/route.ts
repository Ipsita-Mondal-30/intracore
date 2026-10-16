import { api, queryObject } from "@/lib/api/http";
import { createLeaveType, listLeaveTypes } from "@/features/hr/leave";

export const GET = api((ctx, { query }) => listLeaveTypes(ctx, queryObject(query).companyId));
export const POST = api((ctx, { body }) => createLeaveType(ctx, body), { status: 201, idempotent: true });
