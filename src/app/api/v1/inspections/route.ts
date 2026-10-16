import { api, queryObject } from "@/lib/api/http";
import { createInspection, listInspections } from "@/features/quality/inspections";

export const GET = api((ctx, { query }) => listInspections(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createInspection(ctx, body), { status: 201, idempotent: true });
