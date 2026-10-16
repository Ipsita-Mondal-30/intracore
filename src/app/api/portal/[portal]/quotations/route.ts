import { portalApi, salesPortalKind } from "@/features/portal/http";
import { listQuotations } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string }>(salesPortalKind, (p, { query }) => listQuotations(p, Object.fromEntries(query)));
