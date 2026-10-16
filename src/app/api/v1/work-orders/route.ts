import { api, queryObject } from "@/lib/api/http";
import { createWorkOrder, listWorkOrders } from "@/features/manufacturing/work-orders";

export const GET = api((ctx, { query }) => listWorkOrders(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createWorkOrder(ctx, body), { status: 201, idempotent: true });
