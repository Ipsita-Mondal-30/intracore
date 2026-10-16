import { portalApi } from "@/features/portal/http";
import { cancelLeave } from "@/features/portal/employee";

export const POST = portalApi<{ id: string }>("EMPLOYEE", (p, { params, body }) => cancelLeave(p, params.id, body));
