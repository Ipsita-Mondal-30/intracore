import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { cancelStockEntry, createReturn, postStockEntry } from "@/features/inventory/entries";

/** POST /stock-entries/:id/{post|cancel|return} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "post") return postStockEntry(ctx, params.id);
    if (params.action === "cancel") return cancelStockEntry(ctx, params.id, body);
    if (params.action === "return") return createReturn(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown stock entry action", 404);
  },
  { idempotent: true },
);
