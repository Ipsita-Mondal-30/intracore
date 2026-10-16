import { api, queryObject } from "@/lib/api/http";
import { createCustomer, listCustomers } from "@/features/customers/service";

export const GET = api((ctx, { query }) => listCustomers(ctx, queryObject(query)));
/** 409 DUPLICATE with candidate matches in `details` unless `ignoreDuplicates: true`. */
export const POST = api((ctx, { body }) => createCustomer(ctx, body), { status: 201, idempotent: true });
