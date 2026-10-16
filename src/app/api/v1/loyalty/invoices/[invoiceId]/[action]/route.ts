import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { earnForInvoice, reverseForInvoice } from "@/features/marketing/loyalty";

type P = { invoiceId: string; action: string };

/** POST /loyalty/invoices/:invoiceId/{earn|reverse} */
export const POST = api<P>(
  (ctx, { params }) => {
    if (params.action === "earn") return earnForInvoice(ctx, params.invoiceId);
    if (params.action === "reverse") return reverseForInvoice(ctx, params.invoiceId);
    throw new AppError("NOT_FOUND", "Unknown loyalty action", 404);
  },
  { idempotent: true },
);
