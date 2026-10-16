import { portalApi } from "@/features/portal/http";
import { listAttendance } from "@/features/portal/employee";

export const GET = portalApi("EMPLOYEE", (p, { query }) => listAttendance(p, Object.fromEntries(query)));
