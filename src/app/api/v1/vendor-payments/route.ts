import { api, queryObject } from "@/lib/api/http";
import { createVendorPayment, listVendorPayments } from "@/features/finance/payables";

export const GET = api((ctx, { query }) => listVendorPayments(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createVendorPayment(ctx, body), { status: 201, idempotent: true });
