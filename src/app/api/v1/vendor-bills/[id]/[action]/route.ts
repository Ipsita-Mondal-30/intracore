import { api } from "@/lib/api/http";
import { AppError } from "@/lib/errors";
import { approveVendorBill, cancelVendorBill, postVendorBill } from "@/features/purchasing/bills";

/** POST /vendor-bills/:id/{approve|post|cancel} */
export const POST = api<{ id: string; action: string }>(
  (ctx, { params, body }) => {
    if (params.action === "approve") return approveVendorBill(ctx, params.id);
    if (params.action === "post") return postVendorBill(ctx, params.id);
    if (params.action === "cancel") return cancelVendorBill(ctx, params.id, body);
    throw new AppError("NOT_FOUND", "Unknown vendor bill action", 404);
  },
  { idempotent: true },
);
