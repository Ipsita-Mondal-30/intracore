import { portalApi, salesPortalKind } from "@/features/portal/http";
import { listOrders } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string }>(salesPortalKind, (p, { query }) => listOrders(p, Object.fromEntries(query)));
