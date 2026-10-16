import { api } from "@/lib/api/http";
import { getPurchaseOrder, updatePurchaseOrder } from "@/features/purchasing/purchase-orders";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getPurchaseOrder(ctx, params.id));
/** Drafts only. */
export const PATCH = api<P>((ctx, { params, body }) => updatePurchaseOrder(ctx, params.id, body));
