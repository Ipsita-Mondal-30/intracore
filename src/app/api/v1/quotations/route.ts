import { api, queryObject } from "@/lib/api/http";
import { createQuotation, listQuotations } from "@/features/sales/quotations";

export const GET = api((ctx, { query }) => listQuotations(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createQuotation(ctx, body), { status: 201, idempotent: true });
