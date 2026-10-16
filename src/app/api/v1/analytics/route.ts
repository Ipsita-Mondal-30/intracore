import { api, queryObject } from "@/lib/api/http";
import { getDashboard } from "@/features/analytics/metrics";

/** Business dashboard: ?from=yyyy-mm-dd&to=yyyy-mm-dd&companyId= (sections gated per permission). */
export const GET = api((ctx, { query }) => getDashboard(ctx, queryObject(query)));
