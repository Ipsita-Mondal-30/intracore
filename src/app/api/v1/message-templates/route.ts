import { api, queryObject } from "@/lib/api/http";
import { createTemplate, listTemplates } from "@/features/communication/templates";

export const GET = api((ctx, { query }) => listTemplates(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createTemplate(ctx, body), { status: 201, idempotent: true });
