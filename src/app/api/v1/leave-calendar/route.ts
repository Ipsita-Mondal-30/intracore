import { api, queryObject } from "@/lib/api/http";
import { leaveCalendar } from "@/features/hr/leave";

export const GET = api((ctx, { query }) => leaveCalendar(ctx, queryObject(query)));
