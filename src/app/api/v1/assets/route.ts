import { api, queryObject } from "@/lib/api/http";
import { createAsset, listAssets } from "@/features/service/assets";

export const GET = api((ctx, { query }) => listAssets(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createAsset(ctx, body), { status: 201, idempotent: true });
