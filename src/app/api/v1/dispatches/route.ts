import { api, queryObject } from "@/lib/api/http";
import { createDispatch, listDispatches } from "@/features/service/dispatch";

export const GET = api((ctx, { query }) => listDispatches(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createDispatch(ctx, body), { status: 201, idempotent: true });
