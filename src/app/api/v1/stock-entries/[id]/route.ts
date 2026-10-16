import { api } from "@/lib/api/http";
import { getStockEntry } from "@/features/inventory/entries";

export const GET = api<{ id: string }>((ctx, { params }) => getStockEntry(ctx, params.id));
