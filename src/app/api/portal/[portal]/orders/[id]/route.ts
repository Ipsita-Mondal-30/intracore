import { portalApi, salesPortalKind } from "@/features/portal/http";
import { getOrder } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string; id: string }>(salesPortalKind, (p, { params }) => getOrder(p, params.id));
