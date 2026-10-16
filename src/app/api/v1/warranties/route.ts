import { api, queryObject } from "@/lib/api/http";
import { createWarranty, listWarranties } from "@/features/service/assets";

export const GET = api((ctx, { query }) => listWarranties(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createWarranty(ctx, body), { status: 201, idempotent: true });
