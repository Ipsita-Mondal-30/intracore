import { api } from "@/lib/api/http";
import { allocateCredit } from "@/features/finance/receivables";

/** { receiptId | creditNoteId, allocations: [{ invoiceId, amount }] } */
export const POST = api((ctx, { body }) => allocateCredit(ctx, body), { idempotent: true });
