import { api, queryObject } from "@/lib/api/http";
import { createNonConformance, listNonConformances } from "@/features/quality/ncr";

export const GET = api((ctx, { query }) => listNonConformances(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createNonConformance(ctx, body), { status: 201, idempotent: true });
