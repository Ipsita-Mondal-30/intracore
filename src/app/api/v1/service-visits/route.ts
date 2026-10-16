import { api, queryObject } from "@/lib/api/http";
import { listVisits, scheduleVisit } from "@/features/service/field";

export const GET = api((ctx, { query }) => listVisits(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => scheduleVisit(ctx, body), { status: 201, idempotent: true });
