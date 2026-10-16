import { api } from "@/lib/api/http";
import { cancelVendorPayment } from "@/features/finance/payables";

export const POST = api<{ id: string }>((ctx, { params, body }) => cancelVendorPayment(ctx, params.id, body), { idempotent: true });
