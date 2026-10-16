import { api, queryObject } from "@/lib/api/http";
import { listBackgroundJobs } from "@/features/integrations/jobs";

export const GET = api((ctx, { query }) => listBackgroundJobs(ctx, queryObject(query)));
