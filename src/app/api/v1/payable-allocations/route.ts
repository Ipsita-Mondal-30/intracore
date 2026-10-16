import { api } from "@/lib/api/http";
import { allocateDebit } from "@/features/finance/payables";

/** { paymentId | debitNoteId, allocations: [{ billId, amount }] } */
export const POST = api((ctx, { body }) => allocateDebit(ctx, body), { idempotent: true });
