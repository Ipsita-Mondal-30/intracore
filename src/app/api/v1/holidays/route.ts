import { api, queryObject } from "@/lib/api/http";
import { createHoliday, listHolidays } from "@/features/hr/org";

export const GET = api((ctx, { query }) => listHolidays(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createHoliday(ctx, body), { status: 201, idempotent: true });
