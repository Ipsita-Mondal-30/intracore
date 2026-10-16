import { api, queryObject } from "@/lib/api/http";
import { createOpportunity, listOpportunities } from "@/features/opportunities/service";

export const GET = api((ctx, { query }) => listOpportunities(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createOpportunity(ctx, body), { status: 201, idempotent: true });
