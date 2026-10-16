import { api } from "@/lib/api/http";
import { createExpenseCategory, listExpenseCategories } from "@/features/finance/expenses";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => listExpenseCategories(ctx, params.id));
export const POST = api<P>((ctx, { params, body }) => createExpenseCategory(ctx, params.id, body), { status: 201, idempotent: true });
