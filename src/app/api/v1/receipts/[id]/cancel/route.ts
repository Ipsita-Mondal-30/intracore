import { api } from "@/lib/api/http";
import { cancelReceipt } from "@/features/finance/receivables";

export const POST = api<{ id: string }>((ctx, { params, body }) => cancelReceipt(ctx, params.id, body), { idempotent: true });
