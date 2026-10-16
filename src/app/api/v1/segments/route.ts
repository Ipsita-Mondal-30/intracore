import { api, queryObject } from "@/lib/api/http";
import { createSegment, listSegments } from "@/features/marketing/segments";

export const GET = api((ctx, { query }) => listSegments(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createSegment(ctx, body), { status: 201, idempotent: true });
