import { api, queryObject } from "@/lib/api/http";
import { createInstallationJob, listInstallationJobs } from "@/features/service/installations";

export const GET = api((ctx, { query }) => listInstallationJobs(ctx, queryObject(query)));
export const POST = api((ctx, { body }) => createInstallationJob(ctx, body), { status: 201, idempotent: true });
