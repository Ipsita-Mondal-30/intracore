import { api } from "@/lib/api/http";
import { updateWarehouse } from "@/features/inventory/warehouses";

export const PATCH = api<{ id: string }>((ctx, { params, body }) => updateWarehouse(ctx, params.id, body));
