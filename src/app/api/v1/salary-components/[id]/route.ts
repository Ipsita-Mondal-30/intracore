import { api } from "@/lib/api/http";
import { updateSalaryComponent } from "@/features/hr/payroll";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateSalaryComponent(ctx, params.id, body));
