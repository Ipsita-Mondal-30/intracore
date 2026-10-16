import { portalApi } from "@/features/portal/http";
import { transitionInstallation } from "@/features/portal/technician";

/** POST start | complete { notes? } */
export const POST = portalApi<{ id: string; action: string }>("TECHNICIAN", (p, { params, body }) => transitionInstallation(p, params.id, params.action, body));
