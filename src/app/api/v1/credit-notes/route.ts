import { api, queryObject } from "@/lib/api/http";
import { createCreditNote, listCreditNotes } from "@/features/finance/receivables";

export const GET = api((ctx, { query }) => listCreditNotes(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createCreditNote(ctx, body), { status: 201, idempotent: true });
