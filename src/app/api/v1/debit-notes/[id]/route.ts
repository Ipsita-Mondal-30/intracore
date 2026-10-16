import { api } from "@/lib/api/http";
import { getDebitNote } from "@/features/finance/payables";

export const GET = api<{ id: string }>((ctx, { params }) => getDebitNote(ctx, params.id));
