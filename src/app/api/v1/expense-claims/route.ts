import { api, queryObject } from "@/lib/api/http";
import { createExpenseClaim, listExpenseClaims } from "@/features/finance/expenses";

export const GET = api((ctx, { query }) => listExpenseClaims(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createExpenseClaim(ctx, body), { status: 201, idempotent: true });
