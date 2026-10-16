import { portalApi } from "@/features/portal/http";
import { getPayslip } from "@/features/portal/employee";

export const GET = portalApi<{ id: string }>("EMPLOYEE", (p, { params }) => getPayslip(p, params.id));
