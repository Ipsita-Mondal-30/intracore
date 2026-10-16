import { api, queryObject } from "@/lib/api/http";
import { createShift, listShifts } from "@/features/hr/org";

export const GET = api((ctx, { query }) => listShifts(ctx, queryObject(query).companyId));
export const POST = api((ctx, { body }) => createShift(ctx, body), { status: 201, idempotent: true });
