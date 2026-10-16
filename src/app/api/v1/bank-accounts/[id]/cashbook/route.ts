import { api, queryObject } from "@/lib/api/http";
import { getCashbook } from "@/features/finance/bank";

export const GET = api<{ id: string }>((ctx, { params, query }) => getCashbook(ctx, params.id, queryObject(query)));
