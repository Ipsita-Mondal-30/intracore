import { api } from "@/lib/api/http";
import { getVendorBill } from "@/features/purchasing/bills";

export const GET = api<{ id: string }>((ctx, { params }) => getVendorBill(ctx, params.id));
