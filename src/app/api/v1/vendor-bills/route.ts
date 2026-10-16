import { api, queryObject } from "@/lib/api/http";
import { createVendorBill, listVendorBills } from "@/features/purchasing/bills";

export const GET = api((ctx, { query }) => listVendorBills(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createVendorBill(ctx, body), { status: 201, idempotent: true });
