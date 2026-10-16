import { portalApi, salesPortalKind } from "@/features/portal/http";
import { listPayments } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string }>(salesPortalKind, (p, { query }) => listPayments(p, Object.fromEntries(query)));
