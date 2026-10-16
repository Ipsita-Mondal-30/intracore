import { api, queryObject } from "@/lib/api/http";
import { listMyExports, requestExport } from "@/features/reports/exports";

export const GET = api((ctx, { query }) => listMyExports(ctx, queryObject(query)));
/** { definition } or { savedReportId } → 202-style PENDING export generated in the background. */
export const POST = api((ctx, { body }) => requestExport(ctx, body), { status: 201, idempotent: true });
