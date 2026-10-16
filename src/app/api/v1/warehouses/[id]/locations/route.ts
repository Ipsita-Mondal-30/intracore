import { api } from "@/lib/api/http";
import { createLocation } from "@/features/inventory/warehouses";

export const POST = api<{ id: string }>((ctx, { params, body }) => createLocation(ctx, params.id, body), {
  status: 201,
  idempotent: true,
});
