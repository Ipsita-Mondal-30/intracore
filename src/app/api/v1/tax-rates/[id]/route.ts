import { api } from "@/lib/api/http";
import { updateTaxRate } from "@/features/catalog/service";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateTaxRate(ctx, params.id, body));
