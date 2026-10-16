import { api, queryObject } from "@/lib/api/http";
import { createTask, listTasks } from "@/features/projects/tasks";

export const GET = api((ctx, { query }) => listTasks(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createTask(ctx, body), { status: 201, idempotent: true });
