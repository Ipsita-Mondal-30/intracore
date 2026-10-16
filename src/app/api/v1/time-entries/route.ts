import { api, queryObject } from "@/lib/api/http";
import { createTimeEntry, listTimeEntries } from "@/features/projects/time";

export const GET = api((ctx, { query }) => listTimeEntries(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createTimeEntry(ctx, body), { status: 201, idempotent: true });
