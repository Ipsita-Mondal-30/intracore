import { portalApi } from "@/features/portal/http";
import { getPurchaseOrder } from "@/features/portal/vendor";

export const GET = portalApi<{ id: string }>("VENDOR", (p, { params }) => getPurchaseOrder(p, params.id));
