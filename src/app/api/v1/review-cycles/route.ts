import { api, queryObject } from "@/lib/api/http";
import { createReviewCycle, listReviewCycles } from "@/features/hr/performance";

export const GET = api((ctx, { query }) => listReviewCycles(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createReviewCycle(ctx, body), { status: 201, idempotent: true });
