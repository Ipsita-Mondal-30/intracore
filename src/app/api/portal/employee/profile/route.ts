import { portalApi } from "@/features/portal/http";
import { getProfile } from "@/features/portal/employee";

export const GET = portalApi("EMPLOYEE", (p) => getProfile(p));
