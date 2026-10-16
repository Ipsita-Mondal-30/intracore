import { api } from "@/lib/api/http";
import { runReport } from "@/features/reports/builder";

/** Run an ad-hoc report definition (preview, ≤ 1000 rows, 5 s limit). */
export const POST = api((ctx, { body }) => runReport(ctx, body));
