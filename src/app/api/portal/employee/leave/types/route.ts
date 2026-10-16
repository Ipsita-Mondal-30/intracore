import { portalApi } from "@/features/portal/http";
import { listLeaveTypes } from "@/features/portal/employee";

export const GET = portalApi("EMPLOYEE", (p) => listLeaveTypes(p));
