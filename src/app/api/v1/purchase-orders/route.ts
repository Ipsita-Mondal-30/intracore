import { api, queryObject } from "@/lib/api/http";
import { createPurchaseOrder, listPurchaseOrders } from "@/features/purchasing/purchase-orders";

export const GET = api((ctx, { query }) => listPurchaseOrders(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createPurchaseOrder(ctx, body), { status: 201, idempotent: true });
