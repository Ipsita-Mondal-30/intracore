import { api } from "@/lib/api/http";
import { createBankAccount, listBankAccounts } from "@/features/finance/setup";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => listBankAccounts(ctx, params.id));
export const POST = api<P>((ctx, { params, body }) => createBankAccount(ctx, params.id, body), { status: 201, idempotent: true });
