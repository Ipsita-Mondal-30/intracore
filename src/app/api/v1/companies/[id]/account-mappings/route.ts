import { api } from "@/lib/api/http";
import { setAccountMappings } from "@/features/finance/setup";

/** { mappings: { ACCOUNTS_RECEIVABLE: "<accountId>", ... } } */
export const PUT = api<{ id: string }>((ctx, { params, body }) => setAccountMappings(ctx, params.id, body));
