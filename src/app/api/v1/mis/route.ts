import { api, queryObject } from "@/lib/api/http";
import { getMis } from "@/features/analytics/mis";

/** Management MIS for one company: ?companyId=&from=&to= */
export const GET = api((ctx, { query }) => getMis(ctx, queryObject(query)));
