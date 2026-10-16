import { api, queryObject } from "@/lib/api/http";
import { createEmployee, listEmployees } from "@/features/hr/employees";

export const GET = api((ctx, { query }) => listEmployees(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createEmployee(ctx, body), { status: 201, idempotent: true });
