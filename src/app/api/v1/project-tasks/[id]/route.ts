import { api } from "@/lib/api/http";
import { deleteTask, getTask, updateTask } from "@/features/projects/tasks";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getTask(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateTask(ctx, params.id, body));
export const DELETE = api<P>((ctx, { params }) => deleteTask(ctx, params.id));
