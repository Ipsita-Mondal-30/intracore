import { z } from "zod";
import { portalApi } from "@/features/portal/http";
import { listLeaveBalances } from "@/features/portal/employee";

export const GET = portalApi("EMPLOYEE", (p, { query }) =>
  listLeaveBalances(p, z.coerce.number().int().min(2000).max(2100).optional().parse(query.get("year") ?? undefined)),
);
