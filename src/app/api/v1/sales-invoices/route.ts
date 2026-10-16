import { api, queryObject } from "@/lib/api/http";
import { createInvoice, listInvoices } from "@/features/finance/receivables";

export const GET = api((ctx, { query }) => listInvoices(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createInvoice(ctx, body), { status: 201, idempotent: true });
