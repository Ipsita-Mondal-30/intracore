import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { cancelVendorBill, postVendorBill } from "@/features/purchasing/bills";

/** POST /vendor-bills/:id/{post|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "post") return postVendorBill(ctx, params.id);
    if (params.action === "cancel") return cancelVendorBill(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown vendor bill action", 404);
  },
  { idempotent: true },
);
