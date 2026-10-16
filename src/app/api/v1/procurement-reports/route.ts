import { api, queryObject } from "@/lib/api/http";
import { procurementReport } from "@/features/quality/suppliers";

/** GET /procurement-reports?companyId=&from=&to= */
export const GET = api((ctx, { query }) => procurementReport(ctx, queryObject(query)));
