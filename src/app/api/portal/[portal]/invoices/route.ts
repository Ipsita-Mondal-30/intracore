import { portalApi, salesPortalKind } from "@/features/portal/http";
import { listInvoices } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string }>(salesPortalKind, (p, { query }) => listInvoices(p, Object.fromEntries(query)));
