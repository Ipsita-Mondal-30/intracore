import { portalApi, salesPortalKind } from "@/features/portal/http";
import { listContracts } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string }>(salesPortalKind, (p) => listContracts(p));
