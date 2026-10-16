import { api, queryObject } from "@/lib/api/http";
import { createManualJournal, listJournals } from "@/features/finance/journals";

export const GET = api((ctx, { query }) => listJournals(ctx, queryObject(query)));
/** Draft manual journal: { companyId, date, memo, lines: [{ accountId, debit | credit, description? }] } */
export const POST = api((ctx, { body }) => createManualJournal(ctx, body), { status: 201, idempotent: true });
