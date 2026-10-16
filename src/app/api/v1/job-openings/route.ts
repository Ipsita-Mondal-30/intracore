import { api, queryObject } from "@/lib/api/http";
import { createJobOpening, listJobOpenings } from "@/features/hr/recruitment";

export const GET = api((ctx, { query }) => listJobOpenings(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createJobOpening(ctx, body), { status: 201, idempotent: true });
