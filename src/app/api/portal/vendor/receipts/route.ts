import { portalApi } from "@/features/portal/http";
import { listGoodsReceipts } from "@/features/portal/vendor";

export const GET = portalApi("VENDOR", (p, { query }) => listGoodsReceipts(p, Object.fromEntries(query)));
