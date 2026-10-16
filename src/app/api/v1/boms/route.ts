import { api, queryObject } from "@/lib/api/http";
import { createBom, listBoms } from "@/features/manufacturing/boms";

export const GET = api((ctx, { query }) => listBoms(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createBom(ctx, body), { status: 201, idempotent: true });
