import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { cancelSalesOrder, confirmSalesOrder } from "@/features/sales/orders";

/** POST /sales-orders/:id/{confirm|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "confirm") return confirmSalesOrder(ctx, params.id);
    if (params.action === "cancel") return cancelSalesOrder(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown sales order action", 404);
  },
  { idempotent: true },
);
