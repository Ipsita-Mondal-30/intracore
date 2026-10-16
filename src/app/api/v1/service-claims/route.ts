import { api, queryObject } from "@/lib/api/http";
import { listClaims, submitClaim } from "@/features/service/claims";

export const GET = api((ctx, { query }) => listClaims(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => submitClaim(ctx, body), { status: 201, idempotent: true });
