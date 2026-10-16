import { portalApi, salesPortalKind } from "@/features/portal/http";
import { getTicket } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string; id: string }>(salesPortalKind, (p, { params }) => getTicket(p, params.id));
