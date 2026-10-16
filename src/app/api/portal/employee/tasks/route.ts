import { portalApi } from "@/features/portal/http";
import { listMyTasks } from "@/features/portal/employee";

export const GET = portalApi("EMPLOYEE", (p) => listMyTasks(p));
