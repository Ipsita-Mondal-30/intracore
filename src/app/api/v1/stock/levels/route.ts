import { api, queryObject } from "@/lib/api/http";
import { getStockLevels } from "@/features/inventory/stock";

/** ?companyId=&warehouseId=&productId=&lowOnly=true — on hand, reserved, available. */
export const GET = api((ctx, { query }) => getStockLevels(ctx, queryObject(query)));
