import { api, queryObject } from "@/lib/api/http";
import { createSavedReport, listSavedReports } from "@/features/reports/saved";

export const GET = api((ctx, { query }) => listSavedReports(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createSavedReport(ctx, body), { status: 201, idempotent: true });
