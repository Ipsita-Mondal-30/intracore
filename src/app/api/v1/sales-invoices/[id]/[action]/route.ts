import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { cancelInvoice, postInvoice } from "@/features/finance/receivables";
import { registerEInvoice } from "@/features/finance/einvoice";

/** POST /sales-invoices/:id/{post|cancel|einvoice} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "post") return postInvoice(ctx, params.id);
    if (params.action === "cancel") return cancelInvoice(ctx, params.id, body);
    if (params.action === "einvoice") return registerEInvoice(ctx, params.id);
    throw new AppError("NOT_FOUND", "Unknown invoice action", 404);
  },
  { idempotent: true },
);
