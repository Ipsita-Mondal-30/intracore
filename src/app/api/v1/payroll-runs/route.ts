import { api, queryObject } from "@/lib/api/http";
import { createPayrollRun, listPayrollRuns } from "@/features/hr/payroll";

export const GET = api((ctx, { query }) => listPayrollRuns(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createPayrollRun(ctx, body), { status: 201, idempotent: true });
