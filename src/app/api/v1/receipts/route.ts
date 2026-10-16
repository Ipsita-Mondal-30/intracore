import { api, queryObject } from "@/lib/api/http";
import { createReceipt, listReceipts } from "@/features/finance/receivables";

export const GET = api((ctx, { query }) => listReceipts(ctx, queryObject(query)));
/** Records and posts; `allocations: [{ invoiceId, amount }]` settle invoices. */
export const POST = api((ctx, { body }) => createReceipt(ctx, body), { status: 201, idempotent: true });
