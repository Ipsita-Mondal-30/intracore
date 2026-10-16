import { portalApi, salesPortalKind } from "@/features/portal/http";
import { listServiceHistory } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string }>(salesPortalKind, (p) => listServiceHistory(p));
