import { portalApi, salesPortalKind } from "@/features/portal/http";
import { listAssets } from "@/features/portal/customer";

export const GET = portalApi<{ portal: string }>(salesPortalKind, (p) => listAssets(p));
