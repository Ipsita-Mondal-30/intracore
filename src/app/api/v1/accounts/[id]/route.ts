import { api } from "@/lib/api/http";
import { updateAccount } from "@/features/finance/setup";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateAccount(ctx, params.id, body));
