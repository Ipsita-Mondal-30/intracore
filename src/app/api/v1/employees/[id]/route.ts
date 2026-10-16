import { api } from "@/lib/api/http";
import { getEmployee, updateEmployee } from "@/features/hr/employees";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getEmployee(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateEmployee(ctx, params.id, body));
