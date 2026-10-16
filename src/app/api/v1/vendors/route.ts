import { api, queryObject } from "@/lib/api/http";
import { createVendor, listVendors } from "@/features/purchasing/vendors";

export const GET = api((ctx, { query }) => listVendors(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createVendor(ctx, body), { status: 201, idempotent: true });
