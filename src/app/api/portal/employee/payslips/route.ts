import { portalApi } from "@/features/portal/http";
import { listPayslips } from "@/features/portal/employee";

export const GET = portalApi("EMPLOYEE", (p) => listPayslips(p));
