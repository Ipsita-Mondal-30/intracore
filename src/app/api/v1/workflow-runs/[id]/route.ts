import { api } from "@/lib/api/http";
import { getWorkflowRun } from "@/features/automation/workflows";

export const GET = api<{ id: string }>((ctx, { params }) => getWorkflowRun(ctx, params.id));
