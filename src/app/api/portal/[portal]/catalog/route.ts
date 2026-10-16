import { portalApi, dealerOnly } from "@/features/portal/http";
import { listCatalog } from "@/features/portal/dealer";

export const GET = portalApi<{ portal: string }>(dealerOnly, (p) => listCatalog(p));
