import { portalApi } from "@/features/portal/http";
import { transitionVisit } from "@/features/portal/technician";

/** POST start | complete { notes, workDone?, customerSignedBy? } */
export const POST = portalApi<{ id: string; action: string }>("TECHNICIAN", (p, { params, body }) => transitionVisit(p, params.id, params.action, body));
