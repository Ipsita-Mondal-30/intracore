import { api, queryObject } from "@/lib/api/http";
import { createGoal, listGoals } from "@/features/hr/performance";

export const GET = api((ctx, { query }) => listGoals(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createGoal(ctx, body), { status: 201, idempotent: true });
