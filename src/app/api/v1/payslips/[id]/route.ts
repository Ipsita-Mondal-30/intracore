import { api } from "@/lib/api/http";
import { getPayslip } from "@/features/hr/payroll";

export const GET = api<{ id: string }>((ctx, { params }) => getPayslip(ctx, params.id));
