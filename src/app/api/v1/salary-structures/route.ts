import { api, queryObject } from "@/lib/api/http";
import { createSalaryStructure, listSalaryStructures } from "@/features/hr/payroll";

export const GET = api((ctx, { query }) => listSalaryStructures(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createSalaryStructure(ctx, body), { status: 201, idempotent: true });
