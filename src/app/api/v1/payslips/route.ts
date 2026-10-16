import { api, queryObject } from "@/lib/api/http";
import { listPayslips } from "@/features/hr/payroll";

export const GET = api((ctx, { query }) => listPayslips(ctx, queryObject(query)));
