import { api } from "@/lib/api/http";
import { getSalaryStructure, updateSalaryStructure } from "@/features/hr/payroll";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getSalaryStructure(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateSalaryStructure(ctx, params.id, body));
