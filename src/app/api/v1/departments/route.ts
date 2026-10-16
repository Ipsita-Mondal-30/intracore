import { api, queryObject } from "@/lib/api/http";
import { createDepartment, listDepartments } from "@/features/hr/org";

export const GET = api((ctx, { query }) => listDepartments(ctx, queryObject(query).companyId));
export const POST = api((ctx, { body }) => createDepartment(ctx, body), { status: 201, idempotent: true });
