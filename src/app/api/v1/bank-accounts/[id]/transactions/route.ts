import { api, queryObject } from "@/lib/api/http";
import { listBankTransactions } from "@/features/finance/bank";

export const GET = api<{ id: string }>((ctx, { params, query }) => listBankTransactions(ctx, params.id, queryObject(query)));
