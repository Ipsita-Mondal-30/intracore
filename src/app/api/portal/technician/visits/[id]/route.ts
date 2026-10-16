import { portalApi } from "@/features/portal/http";
import { getVisit } from "@/features/portal/technician";

export const GET = portalApi<{ id: string }>("TECHNICIAN", (p, { params }) => getVisit(p, params.id));
