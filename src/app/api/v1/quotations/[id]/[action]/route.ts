import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import {
  QUOTATION_ACTIONS,
  convertQuotationToOrder,
  reviseQuotation,
  transitionQuotation,
  type QuotationAction,
} from "@/features/sales/quotations";

/**
 * POST /quotations/:id/{submit|approve|return|send|accept|reject|cancel|revise|convert}
 * `convert` turns an ACCEPTED quotation into a sales order (at most once).
 */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "revise") return reviseQuotation(ctx, params.id);
    if (params.action === "convert") return convertQuotationToOrder(ctx, params.id);
    if (!QUOTATION_ACTIONS.includes(params.action as QuotationAction)) {
      throw new AppError("NOT_FOUND", "Unknown quotation action", 404);
    }
    return transitionQuotation(ctx, params.id, params.action as QuotationAction, body);
  },
  { idempotent: true },
);
