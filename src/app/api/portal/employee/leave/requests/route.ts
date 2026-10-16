import { portalApi } from "@/features/portal/http";
import { applyLeave, listLeaveRequests } from "@/features/portal/employee";

export const GET = portalApi("EMPLOYEE", (p, { query }) => listLeaveRequests(p, Object.fromEntries(query)));
export const POST = portalApi("EMPLOYEE", (p, { body }) => applyLeave(p, body), { status: 201, idempotent: true });
