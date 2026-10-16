import { api } from "@/lib/api/http";
import { listMetricDefinitions } from "@/features/analytics/metrics";

/** Metric definitions (no values) visible to the caller. */
export const GET = api(async (ctx) => listMetricDefinitions(ctx));
