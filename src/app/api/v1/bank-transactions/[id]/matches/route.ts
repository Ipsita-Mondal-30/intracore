import { api } from "@/lib/api/http";
import { suggestMatches } from "@/features/finance/bank";

export const GET = api<{ id: string }>((ctx, { params }) => suggestMatches(ctx, params.id));
