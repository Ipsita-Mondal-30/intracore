import { api } from "@/lib/api/http";
import { getExpenseClaim, updateExpenseClaim } from "@/features/finance/expenses";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getExpenseClaim(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateExpenseClaim(ctx, params.id, body));
