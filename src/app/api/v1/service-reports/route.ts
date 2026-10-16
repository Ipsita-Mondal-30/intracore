import { api, queryObject } from "@/lib/api/http";
import { serviceReport } from "@/features/service/ticket-reports";

/** GET /service-reports?companyId=&from=&to= */
export const GET = api((ctx, { query }) => serviceReport(ctx, queryObject(query)));
