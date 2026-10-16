import { portalApi, salesPortalKind } from "@/features/portal/http";
import { getQuotation } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string; id: string }>(salesPortalKind, (p, { params }) => getQuotation(p, params.id));
