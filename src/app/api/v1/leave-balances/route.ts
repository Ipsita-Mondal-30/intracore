import { api, queryObject } from "@/lib/api/http";
import { listLeaveBalances, setLeaveBalance } from "@/features/hr/leave";

export const GET = api((ctx, { query }) => listLeaveBalances(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => setLeaveBalance(ctx, body), { idempotent: true });
