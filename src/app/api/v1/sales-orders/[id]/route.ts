import { api } from "@/lib/api/http";
import { getSalesOrder, updateSalesOrder } from "@/features/sales/orders";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getSalesOrder(ctx, params.id));
/** DRAFT: edit. CONFIRMED with nothing delivered: amendment. Otherwise 422. */
export const PATCH = api<P>((ctx, { params, body }) => updateSalesOrder(ctx, params.id, body));
