import { api, queryObject } from "@/lib/api/http";
import { createPerformanceReview, listPerformanceReviews } from "@/features/hr/performance";

export const GET = api((ctx, { query }) => listPerformanceReviews(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createPerformanceReview(ctx, body), { status: 201, idempotent: true });
