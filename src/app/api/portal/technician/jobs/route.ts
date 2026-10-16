import { portalApi } from "@/features/portal/http";
import { listJobs } from "@/features/portal/technician";

export const GET = portalApi("TECHNICIAN", (p, { query }) => listJobs(p, Object.fromEntries(query)));
