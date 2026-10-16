import { api, queryObject } from "@/lib/api/http";
import { createFeedback, listFeedback } from "@/features/marketing/feedback";

export const GET = api((ctx, { query }) => listFeedback(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createFeedback(ctx, body), { status: 201, idempotent: true });
