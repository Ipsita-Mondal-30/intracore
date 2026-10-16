import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { cancelSalesOrder, confirmSalesOrder, reserveSalesOrderStock } from "@/features/sales/orders";
import { deliverSalesOrder } from "@/features/inventory/entries";
import { createInvoiceFromSalesOrder } from "@/features/finance/receivables";

/**
 * POST /sales-orders/:id/{confirm|cancel|reserve|deliver|invoice}
 * confirm reserves stock; reserve tops reservations up; deliver issues stock (goods
 * leave the warehouse when the delivery is posted); cancel releases reservations.
 */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "confirm") return confirmSalesOrder(ctx, params.id);
    if (params.action === "cancel") return cancelSalesOrder(ctx, params.id, body);
    if (params.action === "reserve") return reserveSalesOrderStock(ctx, params.id);
    if (params.action === "deliver") return deliverSalesOrder(ctx, params.id, body);
    // Draft invoice for what is invoiceable now (delivered goods, ordered services).
    if (params.action === "invoice") return createInvoiceFromSalesOrder(ctx, params.id);
    throw new AppError("NOT_FOUND", "Unknown sales order action", 404);
  },
  { idempotent: true },
);
