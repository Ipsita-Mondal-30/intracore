import { api, queryObject } from "@/lib/api/http";
import { listWorkflowRuns } from "@/features/automation/workflows";

export const GET = api((ctx, { query }) => listWorkflowRuns(ctx, queryObject(query)));
