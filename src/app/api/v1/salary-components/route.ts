import { api, queryObject } from "@/lib/api/http";
import { createSalaryComponent, listSalaryComponents } from "@/features/hr/payroll";

export const GET = api((ctx, { query }) => listSalaryComponents(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createSalaryComponent(ctx, body), { status: 201, idempotent: true });
