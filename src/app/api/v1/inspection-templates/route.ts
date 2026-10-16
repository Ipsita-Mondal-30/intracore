import { api, queryObject } from "@/lib/api/http";
import { createInspectionTemplate, listInspectionTemplates } from "@/features/quality/inspections";

export const GET = api((ctx, { query }) => listInspectionTemplates(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createInspectionTemplate(ctx, body), { status: 201, idempotent: true });
