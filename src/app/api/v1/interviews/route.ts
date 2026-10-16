import { api, queryObject } from "@/lib/api/http";
import { listInterviews, scheduleInterview } from "@/features/hr/recruitment";

export const GET = api((ctx, { query }) => listInterviews(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => scheduleInterview(ctx, body), { status: 201, idempotent: true });
