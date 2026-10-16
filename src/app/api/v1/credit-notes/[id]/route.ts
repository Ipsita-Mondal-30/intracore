import { api } from "@/lib/api/http";
import { getCreditNote } from "@/features/finance/receivables";

export const GET = api<{ id: string }>((ctx, { params }) => getCreditNote(ctx, params.id));
