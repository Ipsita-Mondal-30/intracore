import { api } from "@/lib/api/http";
import { updateBranch } from "@/features/companies/service";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateBranch(ctx, params.id, body));
