import { api } from "@/lib/api/http";
import { getReceipt } from "@/features/finance/receivables";

export const GET = api<{ id: string }>((ctx, { params }) => getReceipt(ctx, params.id));
