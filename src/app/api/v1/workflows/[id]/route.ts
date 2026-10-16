import { api } from "@/lib/api/http";
import { getWorkflow, updateWorkflow } from "@/features/automation/workflows";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getWorkflow(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateWorkflow(ctx, params.id, body));
