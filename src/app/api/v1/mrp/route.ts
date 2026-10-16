import { api, queryObject } from "@/lib/api/http";
import { materialRequirements } from "@/features/manufacturing/mrp";

/** GET /mrp?companyId=&warehouseId=&productId=&quantity= */
export const GET = api((ctx, { query }) => materialRequirements(ctx, queryObject(query)));
