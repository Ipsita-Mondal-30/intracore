import { api, queryObject } from "@/lib/api/http";
import { createProject, listProjects } from "@/features/projects/projects";

export const GET = api((ctx, { query }) => listProjects(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createProject(ctx, body), { status: 201, idempotent: true });
