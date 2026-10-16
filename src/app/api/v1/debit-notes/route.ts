import { api, queryObject } from "@/lib/api/http";
import { createDebitNote, listDebitNotes } from "@/features/finance/payables";

export const GET = api((ctx, { query }) => listDebitNotes(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createDebitNote(ctx, body), { status: 201, idempotent: true });
