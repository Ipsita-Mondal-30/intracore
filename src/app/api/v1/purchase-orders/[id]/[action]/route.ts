import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import {
  PURCHASE_ORDER_ACTIONS,
  transitionPurchaseOrder,
  type PurchaseOrderAction,
} from "@/features/purchasing/purchase-orders";
import { receivePurchaseOrder } from "@/features/inventory/entries";

/**
 * POST /purchase-orders/:id/{submit|approve|return|cancel|close|receive}
 * `receive` creates (and by default posts) a goods receipt — the only way a PO adds stock.
 */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "receive") return receivePurchaseOrder(ctx, params.id, body);
    if (!PURCHASE_ORDER_ACTIONS.includes(params.action as PurchaseOrderAction)) {
      throw new AppError("NOT_FOUND", "Unknown purchase order action", 404);
    }
    return transitionPurchaseOrder(ctx, params.id, params.action as PurchaseOrderAction, body);
  },
  { idempotent: true },
);
