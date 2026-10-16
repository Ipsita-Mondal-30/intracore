import { api, queryObject } from "@/lib/api/http";
import { createApplication, listApplications } from "@/features/hr/recruitment";

export const GET = api((ctx, { query }) => listApplications(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createApplication(ctx, body), { status: 201, idempotent: true });
