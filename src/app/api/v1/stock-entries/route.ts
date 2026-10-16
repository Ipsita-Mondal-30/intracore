import { api, queryObject } from "@/lib/api/http";
import { createStockEntry, listStockEntries } from "@/features/inventory/entries";

export const GET = api((ctx, { query }) => listStockEntries(ctx, queryObject(query)));
/** Opening stock, receipts, issues, adjustments and transfers (`post: true` posts at once). */
export const POST = api((ctx, { body }) => createStockEntry(ctx, body), { status: 201, idempotent: true });
