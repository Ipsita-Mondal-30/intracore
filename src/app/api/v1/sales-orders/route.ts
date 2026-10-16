import { api, queryObject } from "@/lib/api/http";
import { createSalesOrder, listSalesOrders } from "@/features/sales/orders";

export const GET = api((ctx, { query }) => listSalesOrders(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createSalesOrder(ctx, body), { status: 201, idempotent: true });
