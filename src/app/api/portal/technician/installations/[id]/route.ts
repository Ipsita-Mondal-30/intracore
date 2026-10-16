import { portalApi } from "@/features/portal/http";
import { getInstallation } from "@/features/portal/technician";

export const GET = portalApi<{ id: string }>("TECHNICIAN", (p, { params }) => getInstallation(p, params.id));
