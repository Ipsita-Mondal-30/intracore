import { portalApi } from "@/features/portal/http";
import { listPurchaseOrders } from "@/features/portal/vendor";

export const GET = portalApi("VENDOR", (p, { query }) => listPurchaseOrders(p, Object.fromEntries(query)));
