import { api } from "@/lib/api/http";
import { createWarehouse, listWarehouses } from "@/features/inventory/warehouses";

export const GET = api((ctx, { query }) => listWarehouses(ctx, query.get("companyId") ?? undefined));
export const POST = api((ctx, { body }) => createWarehouse(ctx, body), { status: 201, idempotent: true });
