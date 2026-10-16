import { api } from "@/lib/api/http";
import { createAccount, listAccounts } from "@/features/finance/setup";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => listAccounts(ctx, params.id));
export const POST = api<P>((ctx, { params, body }) => createAccount(ctx, params.id, body), { status: 201, idempotent: true });
