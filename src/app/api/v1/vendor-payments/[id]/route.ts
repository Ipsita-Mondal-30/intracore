import { api } from "@/lib/api/http";
import { getVendorPayment } from "@/features/finance/payables";

export const GET = api<{ id: string }>((ctx, { params }) => getVendorPayment(ctx, params.id));
