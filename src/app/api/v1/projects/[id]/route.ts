import { api } from "@/lib/api/http";
import { deleteProject, getProject, updateProject } from "@/features/projects/projects";

type P = { id: string };
export const GET = api<P>((ctx, { params }) => getProject(ctx, params.id));
export const PATCH = api<P>((ctx, { params, body }) => updateProject(ctx, params.id, body));
export const DELETE = api<P>((ctx, { params }) => deleteProject(ctx, params.id));
