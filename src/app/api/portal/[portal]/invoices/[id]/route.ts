import { portalApi, salesPortalKind } from "@/features/portal/http";
import { getInvoice } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string; id: string }>(salesPortalKind, (p, { params }) => getInvoice(p, params.id));
