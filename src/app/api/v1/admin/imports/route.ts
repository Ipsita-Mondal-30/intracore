import { api, queryObject } from "@/lib/api/http";
import { listImportJobs, runImport } from "@/features/admin/imports";

export const GET = api((ctx, { query }) => listImportJobs(ctx, queryObject(query)));
// Body: { entity, csv, filename?, dryRun? (default true) }. Not response-cached: a dry run
// writes nothing and a repeated commit skips the rows that now exist as duplicates.
export const POST = api((ctx, { body }) => runImport(ctx, body));
