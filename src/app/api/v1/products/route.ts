import { api, queryObject } from "@/lib/api/http";
import { createProduct, listProducts } from "@/features/catalog/service";

export const GET = api((ctx, { query }) => listProducts(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createProduct(ctx, body), { status: 201, idempotent: true });
