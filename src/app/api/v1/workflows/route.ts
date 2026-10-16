import { api, queryObject } from "@/lib/api/http";
import { createWorkflow, listWorkflows } from "@/features/automation/workflows";

export const GET = api((ctx, { query }) => listWorkflows(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createWorkflow(ctx, body), { status: 201, idempotent: true });
