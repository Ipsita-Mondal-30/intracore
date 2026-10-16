import { api } from "@/lib/api/http";
import { getPayrollRun } from "@/features/hr/payroll";

export const GET = api<{ id: string }>((ctx, { params }) => getPayrollRun(ctx, params.id));
